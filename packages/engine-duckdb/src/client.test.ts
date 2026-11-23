// SPDX-License-Identifier: AGPL-3.0-or-later

import { tableFromArrays, tableToIPC } from 'apache-arrow'
import { describe, expect, it } from 'vitest'
import { baseRowId } from '@assay/domain'
import { compileRowDiffPlan } from '@assay/diff'
import {
  DuckDbEngineClient,
  EngineDisposedError,
  EngineOperationError,
  EngineProtocolError,
  EngineQueryError,
  type EngineComparisonHandle,
  type EngineQueryResult,
  type EngineWorkerFactory,
  type EngineWorkerLike,
} from './client'
import type { EngineRowDiffPlan } from './diff-plan-wire'
import type { DuckDbEngineClientOptions } from './client'
import type {
  EngineColumnSchema,
  EngineCsvPreviewSample,
  EngineCsvSniff,
  EngineFilterSpec,
  EngineRequest,
  EngineResponse,
  EngineSortSpec,
} from './protocol'
import { MAX_RANGE_ROWS } from './range-window'

/**
 * In-memory fake for the worker boundary. It records posted requests and lets
 * tests deliver responses/error events by hand, so the lazy-init state
 * machine is exercised without a real Worker (DuckDB-WASM needs a browser —
 * the real proof is the Playwright e2e). Responses carry *real* Arrow IPC
 * buffers built here in Node via apache-arrow, so the Arrow reconstitution
 * path (parse → tableFromIPC) is exercised end to end.
 */
class FakeWorker implements EngineWorkerLike {
  static readonly instances: FakeWorker[] = []
  readonly postedRequests: EngineRequest[] = []
  terminated = false
  /** How many times `terminate()` was called (C04: disposal must terminate once). */
  terminateCalls = 0
  private readonly messageListeners: Array<(event: MessageEvent<unknown>) => void> = []
  private readonly errorListeners: Array<(event: ErrorEvent) => void> = []

  constructor() {
    FakeWorker.instances.push(this)
  }

  postMessage(request: EngineRequest): void {
    this.postedRequests.push(request)
  }

  terminate(): void {
    this.terminated = true
    this.terminateCalls += 1
  }

  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void
  addEventListener(
    type: 'message' | 'error',
    listener: ((event: MessageEvent<unknown>) => void) | ((event: ErrorEvent) => void),
  ): void {
    if (type === 'message') {
      this.messageListeners.push(listener as (event: MessageEvent<unknown>) => void)
    } else {
      this.errorListeners.push(listener as (event: ErrorEvent) => void)
    }
  }

  /** Deliver a protocol response to the client. */
  respond(response: EngineResponse): void {
    for (const listener of this.messageListeners) {
      listener(new MessageEvent('message', { data: response }))
    }
  }

  /** Deliver a non-protocol message (foreign script sharing the worker). */
  respondRaw(data: unknown): void {
    for (const listener of this.messageListeners) {
      listener(new MessageEvent('message', { data }))
    }
  }

  /** Deliver a worker 'error' event (script crash). Node has no ErrorEvent global — the client only reads `message`. */
  crash(message: string): void {
    for (const listener of this.errorListeners) {
      listener({ message } as unknown as ErrorEvent)
    }
  }

  requestAt(index: number): EngineRequest {
    const request = this.postedRequests[index]
    if (request === undefined) {
      throw new Error(`no request at index ${index}`)
    }
    return request
  }
}

/** Build an Arrow IPC stream (schema + one record batch) for a single int32 column. */
function arrowIpc(values: readonly number[]): Uint8Array {
  return tableToIPC(tableFromArrays({ value: Int32Array.from(values) }))
}

function readyResponse(requestId: number): EngineResponse {
  return { type: 'engine/ready', requestId, duckdbVersion: 'v9.9.9-test' }
}

function queryResultResponse(
  requestId: number,
  values: readonly number[],
  hasMore = false,
): EngineResponse {
  return { type: 'engine/query-result', requestId, batchIpc: arrowIpc(values), hasMore }
}

/** Flush microtasks queued by promise continuations (macrotask boundary). */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function makeClient(options: DuckDbEngineClientOptions = {}): {
  client: DuckDbEngineClient
  workers: FakeWorker[]
} {
  FakeWorker.instances.length = 0
  const factory: EngineWorkerFactory = () => new FakeWorker()
  return {
    client: new DuckDbEngineClient({ workerFactory: factory, ...options }),
    workers: FakeWorker.instances,
  }
}

/** Assert a query result through the Arrow API (never via JS object rows). */
function expectArrowValue(
  result: EngineQueryResult,
  expected: readonly number[],
  hasMore = false,
): void {
  expect(result.hasMore).toBe(hasMore)
  expect(result.batch.numCols).toBe(1)
  expect(result.batch.numRows).toBe(expected.length)
  expect(result.batch.schema.fields[0]?.name).toBe('value')
  expect(valuesOf(result)).toEqual(expected)
}

/** Read the first column via the Arrow vector API. */
function valuesOf(result: EngineQueryResult): number[] {
  const column = result.batch.getChildAt(0)
  if (column === null) {
    throw new Error('result batch has no first column')
  }
  return Array.from({ length: column.length }, (_, i) => column.get(i))
}

describe('DuckDbEngineClient lazy bootstrap', () => {
  it('constructs idle without touching the worker factory', () => {
    const { client, workers } = makeClient()
    expect(client.status).toBe('idle')
    expect(workers).toHaveLength(0)
  })

  it('boots exactly one worker on first use, then reuses it', async () => {
    const { client, workers } = makeClient()

    const first = client.query('SELECT 42 AS value')
    expect(client.status).toBe('booting')
    expect(workers).toHaveLength(1)
    const worker = workers[0]!
    expect(worker.postedRequests.map((r) => r.type)).toEqual(['engine/init'])
    expect(worker.terminated).toBe(false)

    worker.respond(readyResponse(worker.requestAt(0).requestId))
    await flush()
    expect(client.status).toBe('ready')
    expect(worker.postedRequests[1]).toMatchObject({
      type: 'engine/query',
      sql: 'SELECT 42 AS value',
    })

    worker.respond(queryResultResponse(worker.requestAt(1).requestId, [42]))
    const result = await first
    expectArrowValue(result, [42])

    const second = client.query('SELECT 1 AS value')
    await flush()
    expect(workers).toHaveLength(1) // same worker, no re-boot
    expect(worker.postedRequests[2]).toMatchObject({
      type: 'engine/query',
      sql: 'SELECT 1 AS value',
    })
    worker.respond(queryResultResponse(worker.requestAt(2).requestId, [1]))
    expectArrowValue(await second, [1])
  })

  it('coalesces concurrent first calls into one boot', async () => {
    const { client, workers } = makeClient()

    const [a, b] = [client.query('SELECT 1 AS value'), client.query('SELECT 2 AS value')]
    expect(workers).toHaveLength(1)
    const worker = workers[0]!
    expect(worker.postedRequests.filter((r) => r.type === 'engine/init')).toHaveLength(1)

    worker.respond(readyResponse(worker.requestAt(0).requestId))
    await flush()
    const queryIds = worker.postedRequests
      .filter((r) => r.type === 'engine/query')
      .map((r) => r.requestId)
    expect(queryIds).toHaveLength(2)

    worker.respond(queryResultResponse(queryIds[0]!, [1]))
    worker.respond(queryResultResponse(queryIds[1]!, [2]))
    expectArrowValue(await a, [1])
    expectArrowValue(await b, [2])
  })

  it('reconstitutes a multi-row Arrow batch with values readable via the Arrow API', async () => {
    const { client, workers } = makeClient()

    const pending = client.query('SELECT unnest([3, 1, 4, 1, 5]) AS value')
    const worker = workers[0]!
    worker.respond(readyResponse(worker.requestAt(0).requestId))
    await flush()
    worker.respond(queryResultResponse(worker.requestAt(1).requestId, [3, 1, 4, 1, 5]))

    const result = await pending
    expect(result.hasMore).toBe(false)
    expect(result.batch.numRows).toBe(5)
    expect(valuesOf(result)).toEqual([3, 1, 4, 1, 5])
  })

  it('delivers an empty result as a 0-row batch that still carries the schema', async () => {
    const { client, workers } = makeClient()

    const pending = client.query('SELECT 1 AS value WHERE 1 = 0')
    const worker = workers[0]!
    worker.respond(readyResponse(worker.requestAt(0).requestId))
    await flush()
    worker.respond(queryResultResponse(worker.requestAt(1).requestId, []))

    const result = await pending
    expect(result.hasMore).toBe(false)
    expect(result.batch.numRows).toBe(0)
    expect(result.batch.schema.fields[0]?.name).toBe('value')
  })

  it('passes hasMore through when the worker reports a truncated (batch-streamed) result', async () => {
    const { client, workers } = makeClient()

    const pending = client.query('SELECT 1 AS value')
    const worker = workers[0]!
    worker.respond(readyResponse(worker.requestAt(0).requestId))
    await flush()
    worker.respond(queryResultResponse(worker.requestAt(1).requestId, [1], true))

    const result = await pending
    expect(result.hasMore).toBe(true)
    expect(valuesOf(result)).toEqual([1])
  })

  it('rejects with EngineProtocolError when the Arrow IPC payload cannot be parsed', async () => {
    const { client, workers } = makeClient()

    const pending = client.query('SELECT 1 AS value')
    const worker = workers[0]!
    worker.respond(readyResponse(worker.requestAt(0).requestId))
    await flush()
    // A truncated IPC stream (e.g. a half-delivered transfer) fails to parse.
    const truncated = arrowIpc([1]).slice(0, Math.floor(arrowIpc([1]).byteLength / 2))
    worker.respond({
      type: 'engine/query-result',
      requestId: worker.requestAt(1).requestId,
      batchIpc: truncated,
      hasMore: false,
    })

    await expect(pending).rejects.toThrow(EngineProtocolError)
    await expect(pending).rejects.toThrow(/invalid Arrow IPC payload/)
  })

  it('fails the boot on a worker crash, then retries with a fresh worker', async () => {
    const { client, workers } = makeClient()

    const doomed = client.query('SELECT 1 AS value')
    const crashed = workers[0]!
    crashed.crash('wasm exploded')
    await expect(doomed).rejects.toThrow(/wasm exploded/)
    expect(client.status).toBe('failed')
    expect(crashed.terminated).toBe(true)

    const retried = client.query('SELECT 1 AS value')
    expect(workers).toHaveLength(2)
    const fresh = workers[1]!
    expect(fresh).not.toBe(crashed)
    fresh.respond(readyResponse(fresh.requestAt(0).requestId))
    await flush()
    fresh.respond(queryResultResponse(fresh.requestAt(1).requestId, [1]))
    expectArrowValue(await retried, [1])
    expect(client.status).toBe('ready')
  })

  it('rejects an init answered with an error response and stays retryable', async () => {
    const { client, workers } = makeClient()

    const doomed = client.query('SELECT 1 AS value')
    const worker = workers[0]!
    worker.respond({
      type: 'engine/error',
      requestId: worker.requestAt(0).requestId,
      message: 'instantiate failed',
    })
    await expect(doomed).rejects.toThrow(/instantiate failed/)
    expect(client.status).toBe('failed')
    expect(worker.terminated).toBe(true)
  })

  it('rejects a failed query without killing the engine', async () => {
    const { client, workers } = makeClient()

    const boot = client.ensureReady()
    const worker = workers[0]!
    worker.respond(readyResponse(worker.requestAt(0).requestId))
    await expect(boot).resolves.toEqual({ duckdbVersion: 'v9.9.9-test' })

    const bad = client.query('SELEC 1')
    await flush()
    worker.respond({
      type: 'engine/error',
      requestId: worker.requestAt(1).requestId,
      message: 'Parser Error',
    })
    await expect(bad).rejects.toThrow(EngineQueryError)
    await expect(bad).rejects.toThrow(/Parser Error/)
    expect(client.status).toBe('ready')
    expect(worker.terminated).toBe(false)
  })

  it('ignores foreign messages that do not fit the protocol', async () => {
    const { client, workers } = makeClient()

    const pending = client.query('SELECT 42 AS value')
    const worker = workers[0]!
    worker.respondRaw({ hello: 'world' })
    worker.respondRaw(null)
    await flush()
    expect(worker.postedRequests).toHaveLength(1) // still waiting for init

    worker.respond(readyResponse(worker.requestAt(0).requestId))
    await flush()
    worker.respond(queryResultResponse(worker.requestAt(1).requestId, [42]))
    expectArrowValue(await pending, [42])
  })
})

describe('DuckDbEngineClient file lifecycle (M1-4)', () => {
  const fixtureFile = new File([new Uint8Array([1, 2, 3])], 'flat.parquet')
  const source = { name: 'flat.parquet', getFile: () => Promise.resolve(fixtureFile) }

  function openResultResponse(requestId: number): EngineResponse {
    return { type: 'engine/open-result', requestId, tableId: 't1', format: 'parquet' }
  }

  function schemaResultResponse(requestId: number): EngineResponse {
    const columns: EngineColumnSchema[] = [
      { name: 'customer_id', type: 'BIGINT' },
      { name: 'payload', type: 'STRUCT("name" VARCHAR)' },
    ]
    return { type: 'engine/schema-result', requestId, columns }
  }

  it('open() resolves the file once, posts the reference, and returns a table-shaped handle', async () => {
    let getFileCalls = 0
    const countingSource = {
      name: 'flat.parquet',
      getFile: () => {
        getFileCalls += 1
        return Promise.resolve(fixtureFile)
      },
    }
    const { client, workers } = makeClient()
    const pending = client.open(countingSource)
    const worker = workers[0]!
    worker.respond(readyResponse(worker.requestAt(0).requestId))
    await flush()

    // The File itself (a structured-cloneable reference) crosses the boundary.
    expect(worker.requestAt(1)).toMatchObject({
      type: 'engine/open',
      name: 'flat.parquet',
      file: fixtureFile,
    })
    worker.respond(openResultResponse(worker.requestAt(1).requestId))

    const handle = await pending
    expect(getFileCalls).toBe(1)
    expect(handle).toEqual({ kind: 'table', id: 't1' })
    expect(client.status).toBe('ready')
  })

  it('open() rejects engine-reported failures with EngineOperationError and stays usable', async () => {
    const { client, workers } = makeClient()
    const pending = client.open({ name: 'blob.bin', getFile: () => Promise.resolve(fixtureFile) })
    const worker = workers[0]!
    worker.respond(readyResponse(worker.requestAt(0).requestId))
    await flush()
    expect(worker.requestAt(1)).toMatchObject({ type: 'engine/open', name: 'blob.bin' })
    worker.respond({
      type: 'engine/error',
      requestId: worker.requestAt(1).requestId,
      message: 'unsupported dataset format',
    })

    await expect(pending).rejects.toThrow(EngineOperationError)
    expect(client.status).toBe('ready') // operational error, not a crash
    // The engine still answers afterwards.
    const retry = client.query('SELECT 1 AS value')
    await flush()
    worker.respond(queryResultResponse(worker.requestAt(2).requestId, [1]))
    expectArrowValue(await retry, [1])
  })

  it('schema() returns the columns exactly as the worker reported them', async () => {
    const { client, workers } = makeClient()
    const pendingOpen = client.open(source)
    const worker = workers[0]!
    worker.respond(readyResponse(worker.requestAt(0).requestId))
    await flush()
    worker.respond(openResultResponse(worker.requestAt(1).requestId))
    const handle = await pendingOpen

    const pendingSchema = client.schema(handle)
    await flush()
    expect(worker.requestAt(2)).toMatchObject({ type: 'engine/schema', tableId: 't1' })
    worker.respond(schemaResultResponse(worker.requestAt(2).requestId))

    await expect(pendingSchema).resolves.toEqual([
      { name: 'customer_id', type: 'BIGINT' },
      { name: 'payload', type: 'STRUCT("name" VARCHAR)' },
    ])
  })

  it('fetchRange() posts the window and reconstitutes the Arrow batch', async () => {
    const { client, workers } = makeClient()
    const pendingOpen = client.open(source)
    const worker = workers[0]!
    worker.respond(readyResponse(worker.requestAt(0).requestId))
    await flush()
    worker.respond(openResultResponse(worker.requestAt(1).requestId))
    const handle = await pendingOpen

    const pendingRange = client.fetchRange(handle, { startRow: 2, endRow: 4 })
    await flush()
    expect(worker.requestAt(2)).toMatchObject({
      type: 'engine/range',
      tableId: 't1',
      startRow: 2,
      endRow: 4,
    })
    worker.respond({
      type: 'engine/range-result',
      requestId: worker.requestAt(2).requestId,
      batchIpc: arrowIpc([3, 4]),
      hasMore: false,
    })

    const result = await pendingRange
    expect(result.hasMore).toBe(false)
    expect(result.batch.numRows).toBe(2)
    expect(valuesOf(result as unknown as EngineQueryResult)).toEqual([3, 4])
  })

  it('fetchRange() clamps oversized windows before they cross the boundary', async () => {
    const { client, workers } = makeClient()
    const pendingOpen = client.open(source)
    const worker = workers[0]!
    worker.respond(readyResponse(worker.requestAt(0).requestId))
    await flush()
    worker.respond(openResultResponse(worker.requestAt(1).requestId))
    const handle = await pendingOpen

    const pendingRange = client.fetchRange(handle, { startRow: 5000, endRow: 10_000_000 })
    await flush()
    expect(worker.requestAt(2)).toMatchObject({
      type: 'engine/range',
      startRow: 5000,
      endRow: 5000 + MAX_RANGE_ROWS, // clamped client-side; the worker re-clamps anyway
    })
    worker.respond({
      type: 'engine/range-result',
      requestId: worker.requestAt(2).requestId,
      batchIpc: arrowIpc([]),
      hasMore: false,
    })
    await expect(pendingRange).resolves.toBeTruthy()
  })

  it('fetchRange() rejects invalid windows and empty projections without posting', async () => {
    const { client, workers } = makeClient()
    const pendingOpen = client.open(source)
    const worker = workers[0]!
    worker.respond(readyResponse(worker.requestAt(0).requestId))
    await flush()
    worker.respond(openResultResponse(worker.requestAt(1).requestId))
    const handle = await pendingOpen
    const requestsBefore = worker.postedRequests.length

    await expect(client.fetchRange(handle, { startRow: -1, endRow: 5 })).rejects.toThrow(
      EngineOperationError,
    )
    await expect(client.fetchRange(handle, { startRow: 5, endRow: 2 })).rejects.toThrow(
      /invalid row window/,
    )
    await expect(client.fetchRange(handle, { startRow: 0, endRow: 1.5 })).rejects.toThrow(
      EngineOperationError,
    )
    await expect(
      client.fetchRange(handle, { startRow: 0, endRow: 2, columns: [] }),
    ).rejects.toThrow(/columns must not be empty/)
    expect(worker.postedRequests.length).toBe(requestsBefore) // nothing crossed the boundary
  })

  it('fetchRange() passes the column projection through', async () => {
    const { client, workers } = makeClient()
    const pendingOpen = client.open(source)
    const worker = workers[0]!
    worker.respond(readyResponse(worker.requestAt(0).requestId))
    await flush()
    worker.respond(openResultResponse(worker.requestAt(1).requestId))
    const handle = await pendingOpen

    const pendingRange = client.fetchRange(handle, {
      startRow: 0,
      endRow: 3,
      columns: ['customer_id', 'country'],
    })
    await flush()
    expect(worker.requestAt(2)).toMatchObject({
      type: 'engine/range',
      columns: ['customer_id', 'country'],
    })
    worker.respond({
      type: 'engine/range-result',
      requestId: worker.requestAt(2).requestId,
      batchIpc: arrowIpc([1, 2, 3]),
      hasMore: false,
    })
    await expect(pendingRange).resolves.toBeTruthy()
  })

  it('fetchRange() posts filters/sort as copied plain arrays (m2-2)', async () => {
    const { client, workers } = makeClient()
    const pendingOpen = client.open(source)
    const worker = workers[0]!
    worker.respond(readyResponse(worker.requestAt(0).requestId))
    await flush()
    worker.respond(openResultResponse(worker.requestAt(1).requestId))
    const handle = await pendingOpen

    const filters: EngineFilterSpec[] = [{ column: 'income', predicate: '> 50000' }]
    const sort: EngineSortSpec[] = [{ column: 'country', direction: 'desc' }]
    const pendingRange = client.fetchRange(handle, { startRow: 0, endRow: 3, filters, sort })
    await flush()
    const posted = worker.requestAt(2)
    expect(posted).toMatchObject({
      type: 'engine/range',
      filters: [{ column: 'income', predicate: '> 50000' }],
      sort: [{ column: 'country', direction: 'desc' }],
    })
    // Copies: later mutation of the caller's arrays cannot poison the request.
    expect(posted.type === 'engine/range' && posted.filters !== filters).toBe(true)
    filters[0]!.predicate = 'mutated'
    expect(posted.type === 'engine/range' && posted.filters![0]!.predicate).toBe('> 50000')

    worker.respond({
      type: 'engine/range-result',
      requestId: worker.requestAt(2).requestId,
      batchIpc: arrowIpc([5, 2]),
      hasMore: false,
    })
    await expect(pendingRange).resolves.toBeTruthy()
  })

  it('fetchRange() omits filters/sort properties on legacy windows', async () => {
    const { client, workers } = makeClient()
    const pendingOpen = client.open(source)
    const worker = workers[0]!
    worker.respond(readyResponse(worker.requestAt(0).requestId))
    await flush()
    worker.respond(openResultResponse(worker.requestAt(1).requestId))
    const handle = await pendingOpen

    const pendingRange = client.fetchRange(handle, { startRow: 0, endRow: 3 })
    await flush()
    const posted = worker.requestAt(2)
    expect(posted).not.toHaveProperty('filters')
    expect(posted).not.toHaveProperty('sort')
    worker.respond({
      type: 'engine/range-result',
      requestId: worker.requestAt(2).requestId,
      batchIpc: arrowIpc([1, 2, 3]),
      hasMore: false,
    })
    await expect(pendingRange).resolves.toBeTruthy()
  })

  it('source getFile() failures propagate unchanged from the seam', async () => {
    const { client, workers } = makeClient()
    const pending = client.open({
      name: 'flat.parquet',
      getFile: () => Promise.reject(new Error('NotFoundError: file moved')),
    })
    const worker = workers[0]!
    worker.respond(readyResponse(worker.requestAt(0).requestId))
    await expect(pending).rejects.toThrow(/NotFoundError/)
    expect(client.status).toBe('ready')
  })

  it('dispose() gracefully drops registrations, then terminates the worker', async () => {
    const { client, workers } = makeClient()
    const pendingOpen = client.open(source)
    const worker = workers[0]!
    worker.respond(readyResponse(worker.requestAt(0).requestId))
    await flush()
    worker.respond(openResultResponse(worker.requestAt(1).requestId))
    await pendingOpen

    const disposed = client.dispose()
    await flush()
    // The graceful request crossed the boundary *before* termination…
    const disposeRequest = worker.postedRequests.at(-1)
    expect(disposeRequest).toMatchObject({ type: 'engine/dispose' })
    worker.respond({ type: 'engine/disposed', requestId: disposeRequest!.requestId })
    await disposed

    expect(client.status).toBe('disposed')
    expect(worker.terminated).toBe(true)
    await expect(client.query('SELECT 1')).rejects.toThrow(EngineDisposedError)
    // Terminal + idempotent.
    await expect(client.dispose()).resolves.toBeUndefined()
  })

  it('dispose() terminates even when the worker never answers the graceful request', async () => {
    const { client, workers } = makeClient({ disposeTimeoutMs: 20 })
    const boot = client.ensureReady()
    const worker = workers[0]!
    worker.respond(readyResponse(worker.requestAt(0).requestId))
    await boot

    await client.dispose() // resolves via the timeout race, not a reply
    expect(client.status).toBe('disposed')
    expect(worker.terminated).toBe(true)
  })

  it('dispose() before boot is a no-op that stays terminal', async () => {
    const { client, workers } = makeClient()
    await expect(client.dispose()).resolves.toBeUndefined()
    expect(workers).toHaveLength(0)
    expect(client.status).toBe('disposed')
    await expect(client.ensureReady()).rejects.toThrow(EngineDisposedError)
  })

  it('a query that races dispose() rejects instead of hanging (AR-E3)', async () => {
    // The race: `query()` passes `ensureReady()` and then suspends before
    // `send()`. `dispose()` flips the status and sweeps pending work; without
    // the `send()` status re-check the query would add a fresh pending entry
    // and post to a terminated worker, never to settle (the audit probe:
    // `query settled after dispose: false`).
    const { client, workers } = makeClient({ disposeTimeoutMs: 20 })
    const boot = client.ensureReady()
    const worker = workers[0]!
    worker.respond(readyResponse(worker.requestAt(0).requestId))
    await boot

    const queryPromise = client.query('SELECT 1')
    const disposePromise = client.dispose()

    // The awaiting query must true-reject (not hang)…
    await expect(queryPromise).rejects.toThrow(EngineDisposedError)
    await disposePromise
    expect(client.status).toBe('disposed')
    expect(worker.terminated).toBe(true)
    // …and it never reached the worker at all.
    expect(worker.postedRequests.some((request) => request.type === 'engine/query')).toBe(false)
  })

  it('dispose() during in-flight boot fails subsequent ops first; the boot settles harmlessly', async () => {
    const { client, workers } = makeClient({ disposeTimeoutMs: 20 })
    const boot = client.ensureReady() // `engine/init` is now in flight
    const worker = workers[0]!
    expect(client.status).toBe('booting')

    const disposePromise = client.dispose()
    // Post-dispose ops fail-first with the typed error and never re-boot.
    await expect(client.query('SELECT 1')).rejects.toThrow(EngineDisposedError)
    // The in-flight boot resolves to the same typed rejection, not `undefined`.
    await expect(boot).rejects.toThrow(EngineDisposedError)
    await disposePromise

    expect(client.status).toBe('disposed')
    expect(worker.terminated).toBe(true)
    // No resurrecting re-boot: still exactly one worker, no extra `engine/init`.
    expect(workers).toHaveLength(1)
    expect(worker.postedRequests.map((request) => request.type)).toEqual([
      'engine/init',
      'engine/dispose',
    ])
  })

  it('a boot reply racing dispose() cannot resurrect the client to ready', async () => {
    // Deliver `engine/ready`, then call dispose() before the boot continuation
    // runs. Without the permanent disposal sentinel the continuation would set
    // `currentStatus = 'ready'` after disposal, and a later call would re-boot.
    const { client, workers } = makeClient({ disposeTimeoutMs: 20 })
    const boot = client.ensureReady()
    const worker = workers[0]!
    worker.respond(readyResponse(worker.requestAt(0).requestId))
    const disposePromise = client.dispose()

    await expect(boot).rejects.toThrow(EngineDisposedError)
    await disposePromise
    expect(client.status).toBe('disposed')
    await expect(client.ensureReady()).rejects.toThrow(EngineDisposedError)
    expect(workers).toHaveLength(1)
  })
})

describe('DuckDbEngineClient disposal settlement (C04)', () => {
  /** Track whether a promise settled, without awaiting it. */
  function track(promise: Promise<unknown>): { settled: () => boolean; done: Promise<void> } {
    let settled = false
    return {
      settled: () => settled,
      done: promise.then(() => {
        settled = true
      }),
    }
  }

  it('holds every dispose() caller until the one teardown settles (deferred graceful reply)', async () => {
    const { client, workers } = makeClient({ disposeTimeoutMs: 5_000 })
    const boot = client.ensureReady()
    const worker = workers[0]!
    worker.respond(readyResponse(worker.requestAt(0).requestId))
    await boot

    const first = track(client.dispose())
    const second = track(client.dispose())
    const third = track(client.dispose())
    await flush()
    await flush()
    // The graceful request is out but unanswered: NO caller may resolve yet.
    expect(worker.postedRequests.filter((r) => r.type === 'engine/dispose')).toHaveLength(1)
    expect(first.settled()).toBe(false)
    expect(second.settled(), 'a second dispose() must await the same teardown').toBe(false)
    expect(third.settled(), 'every further dispose() must await the same teardown').toBe(false)
    expect(worker.terminated).toBe(false)

    // The worker's graceful reply settles all three through one termination.
    worker.respond({
      type: 'engine/disposed',
      requestId: worker.requestAt(worker.postedRequests.length - 1).requestId,
    })
    await Promise.all([first.done, second.done, third.done])
    expect(first.settled() && second.settled() && third.settled()).toBe(true)
    expect(client.status).toBe('disposed')
    expect(worker.terminated).toBe(true)
    expect(worker.terminateCalls).toBe(1)
    // Exactly one graceful request crossed the boundary.
    expect(worker.postedRequests.filter((r) => r.type === 'engine/dispose')).toHaveLength(1)

    // Terminal + idempotent: a post-completion dispose() still resolves.
    await expect(client.dispose()).resolves.toBeUndefined()
    expect(worker.terminateCalls).toBe(1)
    expect(worker.postedRequests.filter((r) => r.type === 'engine/dispose')).toHaveLength(1)
  })

  it('settles every dispose() caller when the graceful reply never arrives (existing bounded timeout)', async () => {
    const { client, workers } = makeClient({ disposeTimeoutMs: 20 })
    const boot = client.ensureReady()
    const worker = workers[0]!
    worker.respond(readyResponse(worker.requestAt(0).requestId))
    await boot

    const first = track(client.dispose())
    const second = track(client.dispose())
    await flush()
    expect(first.settled()).toBe(false)
    expect(second.settled()).toBe(false)
    await Promise.all([first.done, second.done])
    expect(client.status).toBe('disposed')
    expect(worker.terminated).toBe(true)
    expect(worker.terminateCalls).toBe(1)
  })

  it('keeps the terminal contract while disposal is pending: new and in-flight ops reject with EngineDisposedError', async () => {
    const { client, workers } = makeClient({ disposeTimeoutMs: 5_000 })
    const boot = client.ensureReady()
    const worker = workers[0]!
    worker.respond(readyResponse(worker.requestAt(0).requestId))
    await boot

    const inFlight = client.query('SELECT 1 AS value')
    await flush()
    const queryRequests = (): number =>
      worker.postedRequests.filter((request) => request.type === 'engine/query').length
    expect(queryRequests()).toBe(1) // the in-flight op did reach the worker
    const first = client.dispose()
    const second = client.dispose()
    // Immediate terminal status + pending rejection, before any settlement.
    expect(client.status).toBe('disposed')
    await expect(inFlight).rejects.toThrow(EngineDisposedError)
    await expect(client.query('SELECT 2 AS value')).rejects.toThrow(EngineDisposedError)
    await expect(client.ensureReady()).rejects.toThrow(EngineDisposedError)
    // …and the post-dispose op never crossed the boundary.
    expect(queryRequests()).toBe(1)

    const disposeRequest = worker.postedRequests.at(-1)!
    worker.respond({ type: 'engine/disposed', requestId: disposeRequest.requestId })
    await Promise.all([first, second])
    expect(worker.terminateCalls).toBe(1)
  })

  it('settles every caller when the graceful request cannot be posted', async () => {
    const { client, workers } = makeClient({ disposeTimeoutMs: 5_000 })
    const boot = client.ensureReady()
    const worker = workers[0]!
    worker.respond(readyResponse(worker.requestAt(0).requestId))
    await boot

    // The worker rejects the post (structured-clone style failure).
    const failingPost = worker.postMessage.bind(worker)
    worker.postMessage = (request) => {
      if (request.type === 'engine/dispose') {
        throw new TypeError('could not clone the dispose payload')
      }
      failingPost(request)
    }
    const first = track(client.dispose())
    const second = track(client.dispose())

    await Promise.all([first.done, second.done])
    expect(client.status).toBe('disposed')
    expect(worker.terminated).toBe(true)
    expect(worker.terminateCalls).toBe(1)
  })

  it('settles every caller when the worker crashes mid-disposal', async () => {
    const { client, workers } = makeClient({ disposeTimeoutMs: 5_000 })
    const boot = client.ensureReady()
    const worker = workers[0]!
    worker.respond(readyResponse(worker.requestAt(0).requestId))
    await boot

    const first = track(client.dispose())
    const second = track(client.dispose())
    await flush()
    expect(first.settled()).toBe(false)
    expect(second.settled()).toBe(false)

    worker.crash('worker died during cleanup')
    await Promise.all([first.done, second.done])
    expect(client.status).toBe('disposed')
    expect(worker.terminated).toBe(true)
    // A crashed worker cannot resurrect the engine.
    await expect(client.ensureReady()).rejects.toThrow(EngineDisposedError)
  })

  it('dispose() before boot settles (and stays settled) for every caller', async () => {
    const { client, workers } = makeClient()
    const first = track(client.dispose())
    const second = track(client.dispose())
    await Promise.all([first.done, second.done])
    expect(workers).toHaveLength(0)
    expect(client.status).toBe('disposed')
    await expect(client.dispose()).resolves.toBeUndefined()
    await expect(client.ensureReady()).rejects.toThrow(EngineDisposedError)
  })

  it('a failed boot cannot resurrect ready, and disposal after it still settles', async () => {
    const { client, workers } = makeClient({ disposeTimeoutMs: 20 })
    const doomed = client.query('SELECT 1 AS value')
    const worker = workers[0]!
    worker.respond({
      type: 'engine/error',
      requestId: worker.requestAt(0).requestId,
      message: 'instantiate failed',
    })
    await expect(doomed).rejects.toThrow(/instantiate failed/)
    expect(client.status).toBe('failed')

    const first = track(client.dispose())
    const second = track(client.dispose())
    await Promise.all([first.done, second.done])
    expect(client.status).toBe('disposed')
    await expect(client.ensureReady()).rejects.toThrow(EngineDisposedError)
    expect(client.status).toBe('disposed')
  })

  it('a boot/dispose race settles every disposal caller and never resurrects ready', async () => {
    const { client, workers } = makeClient({ disposeTimeoutMs: 20 })
    const boot = client.ensureReady() // engine/init in flight, no reply
    const worker = workers[0]!
    const first = track(client.dispose())
    const second = track(client.dispose())

    await expect(boot).rejects.toThrow(EngineDisposedError)
    await Promise.all([first.done, second.done])
    expect(client.status).toBe('disposed')
    expect(worker.terminated).toBe(true)
    expect(workers).toHaveLength(1)
    await expect(client.ensureReady()).rejects.toThrow(EngineDisposedError)
  })
})

describe('DuckDbEngineClient row count (M1-5)', () => {
  const source = {
    name: 'flat.parquet',
    getFile: () => Promise.resolve(new File([new Uint8Array([1, 2, 3])], 'flat.parquet')),
  }

  function openResultResponse(requestId: number): EngineResponse {
    return { type: 'engine/open-result', requestId, tableId: 't1', format: 'parquet' }
  }

  it('rowCount() posts the handle and resolves the reported total', async () => {
    const { client, workers } = makeClient()
    const pendingOpen = client.open(source)
    const worker = workers[0]!
    worker.respond(readyResponse(worker.requestAt(0).requestId))
    await flush()
    worker.respond(openResultResponse(worker.requestAt(1).requestId))
    const handle = await pendingOpen

    const pendingCount = client.rowCount(handle)
    await flush()
    expect(worker.requestAt(2)).toMatchObject({ type: 'engine/row-count', tableId: 't1' })
    worker.respond({
      type: 'engine/row-count-result',
      requestId: worker.requestAt(2).requestId,
      rowCount: 1_000_000,
    })

    await expect(pendingCount).resolves.toBe(1_000_000)
  })

  it('rowCount() posts filter options as a copied plain array (m2-2)', async () => {
    const { client, workers } = makeClient()
    const pendingOpen = client.open(source)
    const worker = workers[0]!
    worker.respond(readyResponse(worker.requestAt(0).requestId))
    await flush()
    worker.respond(openResultResponse(worker.requestAt(1).requestId))
    const handle = await pendingOpen

    const filters = [{ column: 'income', predicate: 'IS NOT NULL' }]
    const pendingCount = client.rowCount(handle, { filters })
    await flush()
    const posted = worker.requestAt(2)
    expect(posted).toMatchObject({
      type: 'engine/row-count',
      filters: [{ column: 'income', predicate: 'IS NOT NULL' }],
    })
    expect(posted).not.toHaveProperty('sort')
    filters[0]!.predicate = 'mutated'
    expect(posted.type === 'engine/row-count' && posted.filters![0]!.predicate).toBe('IS NOT NULL')

    worker.respond({
      type: 'engine/row-count-result',
      requestId: worker.requestAt(2).requestId,
      rowCount: 4,
    })
    await expect(pendingCount).resolves.toBe(4)
  })

  it('rowCount() rejects engine-reported failures with EngineOperationError', async () => {
    const { client, workers } = makeClient()
    const pendingOpen = client.open(source)
    const worker = workers[0]!
    worker.respond(readyResponse(worker.requestAt(0).requestId))
    await flush()
    worker.respond(openResultResponse(worker.requestAt(1).requestId))
    const handle = await pendingOpen

    const pendingCount = client.rowCount(handle)
    await flush()
    worker.respond({
      type: 'engine/error',
      requestId: worker.requestAt(2).requestId,
      message: 'unknown table handle: t1',
    })

    await expect(pendingCount).rejects.toThrow(EngineOperationError)
    expect(client.status).toBe('ready') // operational failure, engine stays usable
  })
})

describe('DuckDbEngineClient profile (m2-5)', () => {
  const source = {
    name: 'flat.parquet',
    getFile: () => Promise.resolve(new File([new Uint8Array([1, 2, 3])], 'flat.parquet')),
  }

  function openResultResponse(requestId: number): EngineResponse {
    return { type: 'engine/open-result', requestId, tableId: 't1', format: 'parquet' }
  }

  async function openHandle(): Promise<{
    client: DuckDbEngineClient
    worker: FakeWorker
    handle: Awaited<ReturnType<DuckDbEngineClient['open']>>
  }> {
    const { client, workers } = makeClient()
    // The worker boots lazily on first use — start the open BEFORE grabbing it.
    const pendingOpen = client.open(source)
    const worker = workers[0]!
    worker.respond(readyResponse(worker.requestAt(0).requestId))
    await flush()
    worker.respond(openResultResponse(worker.requestAt(1).requestId))
    return { client, worker, handle: await pendingOpen }
  }

  it('profile() posts the handle and resolves the full stats payload', async () => {
    const { client, worker, handle } = await openHandle()

    const pendingProfile = client.profile(handle)
    await flush()
    const posted = worker.requestAt(2)
    expect(posted).toMatchObject({ type: 'engine/profile', tableId: 't1' })
    worker.respond({
      type: 'engine/profile-result',
      requestId: worker.requestAt(2).requestId,
      rowCount: 5,
      columns: [
        {
          name: 'income',
          type: 'BIGINT',
          kind: 'numeric',
          nullCount: 1,
          distinctCount: 4,
          numeric: {
            min: 48000,
            max: 75000,
            mean: 59000,
            stddev: 11972.189997378648,
            quantiles: { p50: 56500, p90: 70800, p95: 72900, p99: 74580 },
          },
        },
      ],
    })

    await expect(pendingProfile).resolves.toEqual({
      rowCount: 5,
      columns: [
        {
          name: 'income',
          type: 'BIGINT',
          kind: 'numeric',
          nullCount: 1,
          distinctCount: 4,
          numeric: {
            min: 48000,
            max: 75000,
            mean: 59000,
            stddev: 11972.189997378648,
            quantiles: { p50: 56500, p90: 70800, p95: 72900, p99: 74580 },
          },
        },
      ],
    })
    expect(client.status).toBe('ready')
  })

  it('profile() rejects engine-reported failures with EngineOperationError and stays usable', async () => {
    const { client, worker, handle } = await openHandle()

    const pendingProfile = client.profile(handle)
    await flush()
    worker.respond({
      type: 'engine/error',
      requestId: worker.requestAt(2).requestId,
      message: 'unknown table handle: t1',
    })

    await expect(pendingProfile).rejects.toThrow(EngineOperationError)
    expect(client.status).toBe('ready') // operational failure, engine stays usable
  })
})

describe('DuckDbEngineClient comparison profiling (B3)', () => {
  const profileColumns = [
    {
      name: 'income',
      type: 'BIGINT',
      kind: 'numeric' as const,
      nullCount: 1,
      distinctCount: 4,
      numeric: {
        min: 48000,
        max: 75000,
        mean: 59000,
        stddev: 11972.189997378648,
        quantiles: { p50: 56500, p90: 70800, p95: 72900, p99: 74580 },
      },
    },
  ]

  /** Boot a client (one `engine/init`) with no table open. */
  async function readyClient(): Promise<{ client: DuckDbEngineClient; worker: FakeWorker }> {
    const { client, workers } = makeClient()
    const pendingBoot = client.ensureReady()
    const worker = workers[0]!
    worker.respond(readyResponse(worker.requestAt(0).requestId))
    await pendingBoot
    return { client, worker }
  }

  it('posts the comparison id and resolves the existing profile payload unchanged', async () => {
    const { client, worker } = await readyClient()

    const pending = client.profileComparison('d1')
    await flush()
    expect(worker.requestAt(1)).toMatchObject({
      type: 'engine/profile-comparison',
      comparisonId: 'd1',
    })
    worker.respond({
      type: 'engine/profile-result',
      requestId: worker.requestAt(1).requestId,
      rowCount: 5,
      columns: profileColumns,
    })

    await expect(pending).resolves.toEqual({ rowCount: 5, columns: profileColumns })
    expect(client.status).toBe('ready')
  })

  it('passes a hostile id through unchanged and surfaces the worker refusal as EngineOperationError', async () => {
    const { client, worker } = await readyClient()

    // The client does not rewrite or "fix" an address: a table handle or a
    // view name must reach the boundary exactly as given, so the refusal is
    // the worker's typed one (never a client-side reinterpretation).
    const pending = client.profileComparison('assay_t1')
    await flush()
    expect(worker.requestAt(1)).toMatchObject({
      type: 'engine/profile-comparison',
      comparisonId: 'assay_t1',
    })
    worker.respond({
      type: 'engine/error',
      requestId: worker.requestAt(1).requestId,
      message: 'malformed envelope: profile-comparison.comparisonId',
    })

    await expect(pending).rejects.toThrow(EngineOperationError)
    expect(client.status).toBe('ready') // operational failure, engine stays usable
  })

  it('rejects an unexpected response type with a typed protocol error', async () => {
    const { client, worker } = await readyClient()

    const pending = client.profileComparison('d2')
    await flush()
    worker.respond({
      type: 'engine/open-result',
      requestId: worker.requestAt(1).requestId,
      tableId: 't1',
      format: 'parquet',
    })
    await expect(pending).rejects.toThrow(EngineProtocolError)
    expect(client.status).toBe('ready')
  })
})

describe('DuckDbEngineClient overlay + export (m4-2)', () => {
  const source = {
    name: 'flat.parquet',
    getFile: () => Promise.resolve(new File([new Uint8Array([1, 2, 3])], 'flat.parquet')),
  }

  const overlay = {
    base: {
      baseAnchor: 'b1',
      overlayAnchor: 'o1',
      columns: [
        { name: 'id', type: 'BIGINT' },
        { name: 'label', type: 'VARCHAR' },
      ],
      baseRowCount: 2,
    },
    ops: [
      {
        kind: 'cell-set' as const,
        rowId: baseRowId('b1', 0),
        column: 'label',
        value: { kind: 'string' as const, value: 'edited' },
      },
    ],
  }

  async function openHandle(): Promise<{
    client: DuckDbEngineClient
    worker: FakeWorker
    handle: Awaited<ReturnType<DuckDbEngineClient['open']>>
  }> {
    const { client, workers } = makeClient()
    const pendingOpen = client.open(source)
    const worker = workers[0]!
    worker.respond(readyResponse(worker.requestAt(0).requestId))
    await flush()
    worker.respond({
      type: 'engine/open-result',
      requestId: worker.requestAt(1).requestId,
      tableId: 't1',
      format: 'parquet',
    })
    const handle = await pendingOpen
    return { client, worker, handle }
  }

  it('overlaySchema() posts the overlay payload (ops copied) and resolves the effective columns', async () => {
    const { client, worker, handle } = await openHandle()
    const pending = client.overlaySchema(handle, overlay)
    await flush()
    const posted = worker.requestAt(2)
    expect(posted).toMatchObject({ type: 'engine/overlay-schema', tableId: 't1' })
    expect(posted.type === 'engine/overlay-schema' && posted.overlay).toEqual(overlay)
    // The ops array is a defensive copy: mutating the caller's list must not
    // change what was posted.
    overlay.ops.length = 0
    expect(posted.type === 'engine/overlay-schema' && posted.overlay.ops).toHaveLength(1)
    worker.respond({
      type: 'engine/overlay-schema-result',
      requestId: worker.requestAt(2).requestId,
      columns: [
        { name: 'id', type: 'VARCHAR' },
        { name: 'label', type: 'VARCHAR' },
      ],
    })
    await expect(pending).resolves.toEqual([
      { name: 'id', type: 'VARCHAR' },
      { name: 'label', type: 'VARCHAR' },
    ])
  })

  it('overlayRowCount() posts optional filters; engine failures keep the engine usable', async () => {
    const { client, worker, handle } = await openHandle()
    const pending = client.overlayRowCount(handle, overlay, {
      filters: [{ column: 'label', predicate: 'IS NOT NULL' }],
    })
    await flush()
    expect(worker.requestAt(2)).toMatchObject({
      type: 'engine/overlay-row-count',
      filters: [{ column: 'label', predicate: 'IS NOT NULL' }],
    })
    worker.respond({
      type: 'engine/error',
      requestId: worker.requestAt(2).requestId,
      message: 'binder error',
    })
    await expect(pending).rejects.toThrow(EngineOperationError)
    expect(client.status).toBe('ready')
  })

  it('fetchOverlayRange() validates windows client-side, posts the composed window, and reconstitutes the Arrow batch', async () => {
    const { client, worker, handle } = await openHandle()

    await expect(
      client.fetchOverlayRange(handle, overlay, { startRow: 5, endRow: 2 }),
    ).rejects.toThrow(EngineOperationError)
    expect(worker.postedRequests).toHaveLength(2) // nothing posted for the invalid window

    const pending = client.fetchOverlayRange(handle, overlay, {
      startRow: 0,
      endRow: 5,
      includeRowIds: true,
      sort: [{ column: 'label', direction: 'asc' }],
    })
    await flush()
    expect(worker.requestAt(2)).toMatchObject({
      type: 'engine/overlay-range',
      startRow: 0,
      endRow: 5,
      includeRowIds: true,
      sort: [{ column: 'label', direction: 'asc' }],
    })
    worker.respond({
      type: 'engine/overlay-range-result',
      requestId: worker.requestAt(2).requestId,
      batchIpc: arrowIpc([1, 2]),
      hasMore: false,
    })
    const result = await pending
    expect(result.hasMore).toBe(false)
    expect(valuesOf(result)).toEqual([1, 2])
  })

  it('overlayCastCheck() validates target type and column client-side, posts the check, and resolves the boolean (m4-4b)', async () => {
    const { client, worker, handle } = await openHandle()

    // Invalid target spelling: typed operation error, nothing posted.
    await expect(
      client.overlayCastCheck(handle, overlay, { column: 'label', targetType: 'VARCHAR()' }),
    ).rejects.toThrow(EngineOperationError)
    await expect(
      client.overlayCastCheck(handle, overlay, { column: 'label', targetType: 'DECIMAL(1,2,3)' }),
    ).rejects.toThrow(EngineOperationError)
    // Unknown effective column: typed operation error, nothing posted.
    await expect(
      client.overlayCastCheck(handle, overlay, { column: 'nope', targetType: 'BIGINT' }),
    ).rejects.toThrow(EngineOperationError)
    expect(worker.postedRequests).toHaveLength(2) // boot + open only

    const pending = client.overlayCastCheck(handle, overlay, {
      column: 'label',
      targetType: 'BIGINT',
    })
    await flush()
    expect(worker.requestAt(2)).toMatchObject({
      type: 'engine/overlay-cast-check',
      tableId: 't1',
      column: 'label',
      targetType: 'BIGINT',
    })
    worker.respond({
      type: 'engine/overlay-cast-check-result',
      requestId: worker.requestAt(2).requestId,
      hasNonConvertibleValues: true,
    })
    await expect(pending).resolves.toEqual({ hasNonConvertibleValues: true })
    expect(client.status).toBe('ready')
  })

  it('repairPreviewCount() posts the typed op with the plan as data and resolves the exact count (B1/ENG-2)', async () => {
    const { client, worker, handle } = await openHandle()
    const pending = client.repairPreviewCount(handle, overlay, {
      column: 'label',
      trim: ' ',
      // Deliberately unsorted: the boundary canonicalises the pair order, so
      // one plan posts one statement.
      pairs: [
        ['US', 'United States'],
        ['SG', 'Singapore'],
      ],
    })
    await flush()
    const posted = worker.requestAt(2)
    expect(posted).toMatchObject({ type: 'engine/repair-preview-count', tableId: 't1' })
    if (posted.type === 'engine/repair-preview-count') {
      expect(posted.overlay).toEqual(overlay)
      expect(posted.plan).toEqual({
        column: 'label',
        trim: ' ',
        pairs: [
          ['SG', 'Singapore'],
          ['US', 'United States'],
        ],
      })
    }
    worker.respond({
      type: 'engine/repair-preview-count-result',
      requestId: worker.requestAt(2).requestId,
      affected: 3,
    })
    await expect(pending).resolves.toBe(3)
    expect(client.status).toBe('ready')
  })

  it('repairPreviewCount() rejects a malformed or over-cap plan before posting anything (B1/ENG-2)', async () => {
    const { client, worker, handle } = await openHandle()
    // Shape: not a plan at all.
    await expect(
      client.repairPreviewCount(
        handle,
        overlay,
        'label => x' as unknown as { column: string; pairs: [] },
      ),
    ).rejects.toThrow(EngineOperationError)
    // Envelope: empty plan, duplicate key, bad trim, NUL text.
    await expect(
      client.repairPreviewCount(handle, overlay, { column: 'label', pairs: [] }),
    ).rejects.toThrow('repair plan is empty')
    await expect(
      client.repairPreviewCount(handle, overlay, {
        column: 'label',
        pairs: [
          ['a', 'b'],
          ['a', 'c'],
        ],
      }),
    ).rejects.toThrow('repair plan repeats a mapping key')
    await expect(
      client.repairPreviewCount(handle, overlay, {
        column: 'label',
        trim: '',
        pairs: [['a', 'b']],
      }),
    ).rejects.toThrow('repair plan has an invalid trim set')
    await expect(
      client.repairPreviewCount(handle, overlay, {
        column: 'label',
        pairs: [['a\u0000b', 'c']],
      }),
    ).rejects.toThrow('repair plan contains text the engine cannot materialise')
    // Nothing crossed the boundary: boot + open only.
    expect(worker.postedRequests).toHaveLength(2)
  })

  it('exportView() posts format + overlay and resolves the generated destination with honest counts', async () => {
    const { client, worker, handle } = await openHandle()
    const pending = client.exportView(handle, { format: 'csv', overlay })
    await flush()
    expect(worker.requestAt(2)).toMatchObject({ type: 'engine/export', format: 'csv' })
    worker.respond({
      type: 'engine/export-result',
      requestId: worker.requestAt(2).requestId,
      path: 'assay-exports/assay-export-1.csv',
      format: 'csv',
      rowCount: 3,
      bytes: 42,
    })
    await expect(pending).resolves.toEqual({
      path: 'assay-exports/assay-export-1.csv',
      format: 'csv',
      rowCount: 3,
      bytes: 42,
    })

    // An unexpected response type is a protocol error, not a silent lie.
    const pending2 = client.exportView(handle, { format: 'parquet', overlay })
    await flush()
    worker.respond({
      type: 'engine/disposed',
      requestId: worker.requestAt(3).requestId,
    })
    await expect(pending2).rejects.toThrow(EngineProtocolError)
  })

  it('rejects hostile overlay type expressions with a typed EngineOperationError before posting (m4-2 fix)', async () => {
    const { client, worker, handle } = await openHandle()
    const PAYLOAD = 'VARCHAR) AS "c" FROM (...) ); CREATE TABLE assay_injected AS SELECT 31337; --'
    const hostileCast = {
      base: overlay.base,
      ops: [{ kind: 'column-cast' as const, column: 'label', targetType: PAYLOAD }],
    }
    const hostileBase = {
      base: {
        ...overlay.base,
        columns: [overlay.base.columns[0]!, { name: 'label', type: PAYLOAD }],
      },
      ops: [],
    }
    for (const hostile of [hostileCast, hostileBase]) {
      await expect(client.overlaySchema(handle, hostile)).rejects.toThrow(EngineOperationError)
      await expect(client.overlayRowCount(handle, hostile)).rejects.toThrow(EngineOperationError)
      await expect(
        client.fetchOverlayRange(handle, hostile, { startRow: 0, endRow: 1 }),
      ).rejects.toThrow(EngineOperationError)
      await expect(client.exportView(handle, { format: 'csv', overlay: hostile })).rejects.toThrow(
        EngineOperationError,
      )
    }
    // Nothing crossed the worker boundary: only the open's boot + open posts.
    expect(worker.postedRequests).toHaveLength(2)
    expect(client.status).toBe('ready')
  })

  it('rejects malformed type arities with a typed EngineOperationError before posting (m4-2 fix round 2)', async () => {
    const { client, worker, handle } = await openHandle()
    const malformed = [
      'DECIMAL(1,2,3)',
      'DECIMAL()',
      'VARCHAR()',
      'MAP(INTEGER)',
      'STRUCT()',
      'ENUM()',
      'LIST()',
      'UNION()',
      'DECIMAL(200)',
      'DECIMAL(1,2)',
      'INTEGER[0]',
      'DATE(2)',
    ]
    for (const targetType of malformed) {
      const hostile = {
        base: overlay.base,
        ops: [{ kind: 'column-cast' as const, column: 'label', targetType }],
      }
      await expect(client.overlaySchema(handle, hostile)).rejects.toThrow(EngineOperationError)
      await expect(client.overlayRowCount(handle, hostile)).rejects.toThrow(EngineOperationError)
      await expect(
        client.fetchOverlayRange(handle, hostile, { startRow: 0, endRow: 1 }),
      ).rejects.toThrow(EngineOperationError)
      await expect(client.exportView(handle, { format: 'csv', overlay: hostile })).rejects.toThrow(
        EngineOperationError,
      )
    }
    expect(worker.postedRequests).toHaveLength(2)
    expect(client.status).toBe('ready')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// m5-2: client.validate()
// ─────────────────────────────────────────────────────────────────────────────

import type { EngineValidationPlan, EngineValidationResult } from './validate-plan-wire'

describe('DuckDbEngineClient validate (m5-2)', () => {
  const source = {
    name: 'flat.parquet',
    getFile: () => Promise.resolve(new File([new Uint8Array([1, 2, 3])], 'flat.parquet')),
  }
  const overlay = {
    base: {
      baseAnchor: 'b1',
      overlayAnchor: 'o1',
      columns: [{ name: 'id', type: 'BIGINT' }],
      baseRowCount: 2,
    },
    ops: [],
  }

  function planFixture(): EngineValidationPlan {
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

  async function openHandle(): Promise<{
    client: DuckDbEngineClient
    worker: FakeWorker
    handle: Awaited<ReturnType<DuckDbEngineClient['open']>>
  }> {
    const { client, workers } = makeClient()
    const pendingOpen = client.open(source)
    const worker = workers[0]!
    worker.respond(readyResponse(worker.requestAt(0).requestId))
    await flush()
    worker.respond({
      type: 'engine/open-result',
      requestId: worker.requestAt(1).requestId,
      tableId: 't1',
      format: 'parquet',
    })
    const handle = await pendingOpen
    return { client, worker, handle }
  }

  it('validate() posts the plan + overlay and resolves the result', async () => {
    const { client, worker, handle } = await openHandle()
    const result: EngineValidationResult = {
      valid: true,
      rowCount: 6,
      rules: [
        {
          ruleId: 'columns[0].required',
          outcome: 'row-samples',
          failCount: 0,
          failPercent: 0,
          sampleFailures: [],
        },
      ],
    }
    const pending = client.validate(handle, planFixture(), overlay)
    await flush()
    const request = worker.requestAt(2)
    expect(request.type).toBe('engine/validate')
    if (request.type !== 'engine/validate') return
    expect(request.tableId).toBe('t1')
    expect(request.plan).toEqual(planFixture())
    expect(request.overlay).toEqual({ base: overlay.base, ops: [] })
    worker.respond({
      type: 'engine/validate-result',
      requestId: request.requestId,
      result,
    })
    await expect(pending).resolves.toEqual(result)
  })

  it('validate() omits the overlay field when none is given (plain base view)', async () => {
    const { client, worker, handle } = await openHandle()
    const pending = client.validate(handle, planFixture())
    await flush()
    const request = worker.requestAt(2)
    expect(request.type).toBe('engine/validate')
    if (request.type !== 'engine/validate') return
    expect('overlay' in request).toBe(false)
    worker.respond({
      type: 'engine/validate-result',
      requestId: request.requestId,
      result: { valid: true, rowCount: 0, rules: [] },
    })
    await pending
  })

  it('validate() rejects a malformed plan client-side with a typed error before posting', async () => {
    const { client, worker, handle } = await openHandle()
    const malformed = { ...planFixture(), sampleLimit: 0 } as unknown as EngineValidationPlan
    await expect(client.validate(handle, malformed)).rejects.toBeInstanceOf(EngineOperationError)
    expect(worker.postedRequests).toHaveLength(2) // init + open only
  })

  it('posts ANY safe-integer K ≥ 1 — over-max K is engine-clamped, not refused (m5-2 round-3 fix)', async () => {
    const { client, worker, handle } = await openHandle()
    // The round-3 adjudication (CLAMP, don't reject): the wire no longer
    // refuses K > 100 — the executor clamps the executed rule queries. The
    // plan leaves the main thread for every safe K; only K < 1 is refused
    // client-side (pinned above).
    for (const k of [101, 500, 2 ** 53 - 1]) {
      const clamped = {
        ...planFixture(),
        sampleLimit: k,
      } as unknown as EngineValidationPlan
      const pending = client.validate(handle, clamped)
      await flush()
      const request = worker.requestAt(worker.postedRequests.length - 1)
      expect(request.type).toBe('engine/validate')
      worker.respond({
        type: 'engine/validate-result',
        requestId: request.requestId,
        result: { valid: true, rowCount: 0, rules: [] },
      })
      await expect(pending).resolves.toEqual({ valid: true, rowCount: 0, rules: [] })
    }
    expect(worker.postedRequests).toHaveLength(5) // init + open + 3 validates
  })

  it('REJECTS (never hangs) when a validate response fails shape validation (m5-2 round-3, item 3)', async () => {
    const { client, worker, handle } = await openHandle()
    // The reviewer's exact two-row probe injected directly: a response
    // carrying failCount 3 over rowCount 2 (failPercent 150) is out of
    // contract for its row-samples outcome. The old behavior discarded it
    // silently and left validate() pending forever; now the pending promise
    // rejects with a typed protocol error and the client stays usable.
    const pending = client.validate(handle, planFixture())
    await flush()
    const request = worker.requestAt(2)
    worker.respond({
      type: 'engine/validate-result',
      requestId: request.requestId,
      result: {
        valid: false,
        rowCount: 2,
        rules: [
          {
            ruleId: 'columns[0].required',
            outcome: 'row-samples',
            failCount: 3,
            failPercent: 150,
            sampleFailures: [],
          },
        ],
      },
    })
    await expect(pending).rejects.toBeInstanceOf(EngineProtocolError)
    // A follow-up query still works.
    const followUp = client.query('SELECT 42 AS answer')
    await flush()
    worker.respond(queryResultResponse(worker.requestAt(3).requestId, [42]))
    await expect(followUp).resolves.toMatchObject({ hasMore: false })
  })

  it('still ignores raw non-protocol messages (foreign scripts) without rejecting anything', async () => {
    const { client, worker, handle } = await openHandle()
    const pending = client.validate(handle, planFixture())
    await flush()
    // A foreign message with an engine-shaped type but an unknown requestId:
    // not ours — the ignore contract is unchanged.
    worker.respondRaw({ type: 'engine/validate-result', requestId: 9999, result: null })
    worker.respondRaw('garbage')
    worker.respondRaw(null)
    await flush()
    const request = worker.requestAt(2)
    worker.respond({
      type: 'engine/validate-result',
      requestId: request.requestId,
      result: { valid: true, rowCount: 0, rules: [] },
    })
    await expect(pending).resolves.toEqual({ valid: true, rowCount: 0, rules: [] })
  })

  it('validate() maps engine-reported failures to EngineOperationError and stays usable', async () => {
    const { client, worker, handle } = await openHandle()
    const pending = client.validate(handle, planFixture())
    await flush()
    const request = worker.requestAt(2)
    worker.respond({ type: 'engine/error', requestId: request.requestId, message: 'boom' })
    await expect(pending).rejects.toBeInstanceOf(EngineOperationError)
    // The engine stays usable.
    const followUp = client.rowCount(handle)
    await flush()
    worker.respond({
      type: 'engine/row-count-result',
      requestId: worker.requestAt(3).requestId,
      rowCount: 5,
    })
    await expect(followUp).resolves.toBe(5)
  })
})

// m6-2: client.stageComparison() + client.diff()
// ─────────────────────────────────────────────────────────────────────────────

describe('DuckDbEngineClient stageComparison/diff (m6-2)', () => {
  const source = {
    name: 'comparison.parquet',
    getFile: () => Promise.resolve(new File([new Uint8Array([1, 2, 3])], 'comparison.parquet')),
  }

  function rowDiffPlanFixture(): EngineRowDiffPlan {
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
      { relationA: 'assay_conf_a', relationB: 'assay_conf_b', sampleLimit: 5 },
    )
    if (!result.ok) throw new Error(`fixture compile failed: ${JSON.stringify(result.errors)}`)
    return result.plan
  }

  async function openHandle(): Promise<{
    client: DuckDbEngineClient
    worker: FakeWorker
    handle: Awaited<ReturnType<DuckDbEngineClient['open']>>
  }> {
    const { client, workers } = makeClient()
    const pendingOpen = client.open(source)
    const worker = workers[0]!
    worker.respond(readyResponse(worker.requestAt(0).requestId))
    await flush()
    worker.respond({
      type: 'engine/open-result',
      requestId: worker.requestAt(1).requestId,
      tableId: 't1',
      format: 'parquet',
    })
    const handle = await pendingOpen
    return { client, worker, handle }
  }

  it('stageComparison() posts the file and resolves the comparison handle', async () => {
    const { client, worker } = await openHandle()
    const pending = client.stageComparison(source)
    await flush()
    const request = worker.requestAt(2)
    expect(request.type).toBe('engine/diff-stage')
    if (request.type !== 'engine/diff-stage') return
    worker.respond({
      type: 'engine/diff-stage-result',
      requestId: request.requestId,
      comparisonId: 'd1',
      columns: [{ name: 'id', type: 'BIGINT' }],
    })
    await expect(pending).resolves.toEqual({
      kind: 'comparison',
      id: 'd1',
      schema: [{ name: 'id', type: 'BIGINT' }],
    })
  })

  it('stageComparison() REJECTS (never hangs) on a shape-invalid stage response', async () => {
    const { client, worker, handle } = await openHandle()
    const pending = client.stageComparison(source)
    await flush()
    const request = worker.requestAt(2)
    // `columns` is not a column-schema list — the protocol shape rejects it.
    worker.respond({
      type: 'engine/diff-stage-result',
      requestId: request.requestId,
      comparisonId: 'd1',
      columns: 'not-a-column-list',
    } as unknown as EngineResponse)
    await expect(pending).rejects.toBeInstanceOf(EngineProtocolError)
    // The client stays usable.
    const followUp = client.rowCount(handle)
    await flush()
    worker.respond({
      type: 'engine/row-count-result',
      requestId: worker.requestAt(3).requestId,
      rowCount: 5,
    })
    await expect(followUp).resolves.toBe(5)
  })

  it('diff() REJECTS (never hangs) on a shape-invalid diff response', async () => {
    const { client, worker, handle } = await openHandle()
    const comparison: EngineComparisonHandle = {
      kind: 'comparison',
      id: 'd1',
      schema: [{ name: 'id', type: 'BIGINT' }],
    }
    const pending = client.diff(handle, comparison, rowDiffPlanFixture())
    await flush()
    const request = worker.requestAt(2)
    expect(request.type).toBe('engine/diff')
    // Two aspects instead of three — the result shape is malformed.
    worker.respond({
      type: 'engine/diff-result',
      requestId: request.requestId,
      result: { rowCountA: 0, rowCountB: 0, aspects: [] },
    } as unknown as EngineResponse)
    await expect(pending).rejects.toBeInstanceOf(EngineProtocolError)
    // The client stays usable.
    const followUp = client.rowCount(handle)
    await flush()
    worker.respond({
      type: 'engine/row-count-result',
      requestId: worker.requestAt(3).requestId,
      rowCount: 5,
    })
    await expect(followUp).resolves.toBe(5)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// au3-4 (S3): send() postMessage hardening + client-side File guards
// ─────────────────────────────────────────────────────────────────────────────

describe('DuckDbEngineClient send() hardening (au3-4 S3)', () => {
  const fixtureFile = new File([new Uint8Array([1, 2, 3])], 'flat.parquet')
  const source = { name: 'flat.parquet', getFile: () => Promise.resolve(fixtureFile) }

  /** Direct observation of the client's private pending map (no public accessor exists). */
  function pendingSize(client: DuckDbEngineClient): number {
    return (client as unknown as { pending: Map<number, unknown> }).pending.size
  }

  function openResultResponse(requestId: number): EngineResponse {
    return { type: 'engine/open-result', requestId, tableId: 't1', format: 'parquet' }
  }

  it('rejects with EngineOperationError and clears the pending entry when postMessage throws', async () => {
    // Simulate the audited clone failure: the fake worker's `postMessage`
    // throws synchronously for the open request (an uncloneable File).
    class ThrowingWorker extends FakeWorker {
      override postMessage(request: EngineRequest): void {
        if (request.type === 'engine/open') {
          throw new TypeError('could not be cloned')
        }
        super.postMessage(request)
      }
    }
    FakeWorker.instances.length = 0
    const factory: EngineWorkerFactory = () => new ThrowingWorker()
    const client = new DuckDbEngineClient({ workerFactory: factory })
    const pending = client.open(source)
    // Attach the rejection handler before the boot reply flushes, so the
    // deliberately-failed post is never an unhandled rejection.
    const rejection = expect(pending).rejects.toBeInstanceOf(EngineOperationError)
    const worker = FakeWorker.instances[0]!
    worker.respond(readyResponse(worker.requestAt(0).requestId))
    await flush()
    await rejection

    await expect(pending).rejects.toThrow(/could not be posted/)
    // The raw clone TypeError must not be the rejection surface.
    await expect(pending).rejects.not.toBeInstanceOf(TypeError)
    // The op never crossed the boundary, and the audited stale entry is gone.
    expect(worker.postedRequests.map((request) => request.type)).toEqual(['engine/init'])
    expect(pendingSize(client)).toBe(0)
    // Operational failure, not a crash: the client stays usable and clean.
    expect(client.status).toBe('ready')
    const retry = client.query('SELECT 1 AS value')
    await flush()
    worker.respond(queryResultResponse(worker.requestAt(1).requestId, [1]))
    expectArrowValue(await retry, [1])
    expect(pendingSize(client)).toBe(0)
  })

  it('open() rejects a non-File source with EngineOperationError before posting', async () => {
    const { client, workers } = makeClient()
    const boot = client.ensureReady()
    const worker = workers[0]!
    worker.respond(readyResponse(worker.requestAt(0).requestId))
    await boot

    const notAFile = { name: 'flat.parquet', size: 3 } as unknown as File
    const guarded = client.open({ name: 'flat.parquet', getFile: () => Promise.resolve(notAFile) })
    await expect(guarded).rejects.toBeInstanceOf(EngineOperationError)
    await expect(guarded).rejects.toThrow(/requires a File source/)
    // Only boot crossed the boundary — the non-File never posted.
    expect(worker.postedRequests.map((request) => request.type)).toEqual(['engine/init'])
    expect(pendingSize(client)).toBe(0)
    expect(client.status).toBe('ready')
  })

  it('stageComparison() rejects a non-File source with EngineOperationError before posting', async () => {
    const { client, workers } = makeClient()
    const pendingOpen = client.open(source)
    const worker = workers[0]!
    worker.respond(readyResponse(worker.requestAt(0).requestId))
    await flush()
    worker.respond(openResultResponse(worker.requestAt(1).requestId))
    await pendingOpen

    const notAFile = 'not-a-file' as unknown as File
    const pending = client.stageComparison({
      name: 'comparison.parquet',
      getFile: () => Promise.resolve(notAFile),
    })
    await expect(pending).rejects.toBeInstanceOf(EngineOperationError)
    await expect(pending).rejects.toThrow(/requires a File source/)
    // Only boot + open crossed the boundary.
    expect(worker.postedRequests.map((request) => request.type)).toEqual([
      'engine/init',
      'engine/open',
    ])
    expect(pendingSize(client)).toBe(0)
    expect(client.status).toBe('ready')
  })
})

// ── p-3: runPipeline client binding (typed wire ops, value-free outcomes) ────

import {
  PipelineRunError,
  PipelineRunGuard,
  PipelineRunRefusalError,
} from './pipeline-runner/index'
import type { PipelineRunOptions, PipelineRunResult } from './pipeline-runner/index'
import type { PipelineV1 } from '@assay/pipeline'

function journeyPipeline(): PipelineV1 {
  return {
    version: 1,
    pipeline: 'journey',
    nodes: [
      { id: 'customers', type: 'source', source: { kind: 'file' } },
      {
        id: 'sg',
        type: 'transform',
        inputs: ['customers'],
        operation: {
          operation: 'filter',
          args: { predicates: [{ column: 'country', operator: 'equals', value: 'SG' }] },
        },
      },
      { id: 'out', type: 'sql', inputs: ['sg'], sql: 'SELECT customer_id FROM sg' },
    ],
  }
}

const journeySource = {
  name: 'customers.parquet',
  getFile: async () => new File([new Uint8Array([1])], 'customers.parquet'),
}

/**
 * Drive ONE `runPipeline` call against the scripted fake worker (p2c-2 (d)).
 * The client's ops are strictly sequential (each awaits its response), so we
 * answer the next posted request until the run settles — a long-lived
 * session's consecutive runs reuse the SAME client/worker. Returns the number
 * of `engine/pipeline-handle` registrations the run made, so a test can pin
 * the per-run handle discipline.
 */
async function driveClientRun(
  client: DuckDbEngineClient,
  workers: FakeWorker[],
  pipeline: PipelineV1,
  options: PipelineRunOptions,
  startIndex: number,
  verdicts: readonly boolean[],
  handleId: string,
): Promise<{ result: PipelineRunResult; endIndex: number; handleRequests: number }> {
  const pending = client.runPipeline(pipeline, options)
  let index = startIndex
  let validateIndex = 0
  let handleRequests = 0
  let settled = false
  let result: PipelineRunResult | undefined
  void pending.then(
    (value) => {
      result = value
      settled = true
    },
    () => {
      settled = true
    },
  )
  for (let guard = 0; guard < 200 && !settled; guard += 1) {
    await flush()
    if (settled) break
    const worker = workers[0]
    if (worker === undefined) throw new Error('the client never booted a worker')
    const request = worker.requestAt(index)
    index += 1
    switch (request.type) {
      case 'engine/init':
        worker.respond(readyResponse(request.requestId))
        break
      case 'engine/pipeline-source':
        worker.respond({
          type: 'engine/pipeline-source-result',
          requestId: request.requestId,
          relation: 'customers',
          rowCount: 5,
        })
        break
      case 'engine/pipeline-execute':
        worker.respond({
          type: 'engine/pipeline-execute-result',
          requestId: request.requestId,
          relation: 'sg',
          materialization: 'view',
          rowCount: 2,
        })
        break
      case 'engine/pipeline-handle':
        handleRequests += 1
        worker.respond({
          type: 'engine/pipeline-handle-result',
          requestId: request.requestId,
          relation: 'sg',
          tableId: handleId,
        })
        break
      case 'engine/schema':
        worker.respond({
          type: 'engine/schema-result',
          requestId: request.requestId,
          columns: [{ name: 'customer_id', type: 'BIGINT' }],
        })
        break
      case 'engine/validate': {
        const valid = verdicts[validateIndex] ?? true
        validateIndex += 1
        worker.respond({
          type: 'engine/validate-result',
          requestId: request.requestId,
          result: {
            valid,
            rowCount: 2,
            rules: [
              {
                ruleId: 'columns[0].required',
                outcome: 'row-samples',
                failCount: valid ? 0 : 1,
                failPercent: 0,
                sampleFailures: [],
              },
            ],
          },
        })
        break
      }
      default:
        throw new Error(`unexpected request ${request.type}`)
    }
  }
  await pending
  if (result === undefined) throw new Error('the run did not settle')
  return { result, endIndex: index, handleRequests }
}

describe('DuckDbEngineClient.runPipeline', () => {
  it('compiles the IR and drives source + node ops in topological order', async () => {
    const { client, workers } = makeClient()
    const pending = client.runPipeline(journeyPipeline(), {
      sources: [{ nodeId: 'customers', source: journeySource }],
    })
    await flush()
    const worker = workers[0]!
    worker.respond(readyResponse(worker.requestAt(0).requestId))
    await flush()

    expect(worker.requestAt(1)).toMatchObject({
      type: 'engine/pipeline-source',
      relation: 'customers',
    })
    worker.respond({
      type: 'engine/pipeline-source-result',
      requestId: worker.requestAt(1).requestId,
      relation: 'customers',
      rowCount: 5,
    })
    await flush()
    expect(worker.requestAt(2)).toMatchObject({
      type: 'engine/pipeline-execute',
      relation: 'sg',
    })
    worker.respond({
      type: 'engine/pipeline-execute-result',
      requestId: worker.requestAt(2).requestId,
      relation: 'sg',
      materialization: 'view',
      rowCount: 2,
    })
    await flush()
    expect(worker.requestAt(3)).toMatchObject({
      type: 'engine/pipeline-execute',
      relation: 'out',
    })
    worker.respond({
      type: 'engine/pipeline-execute-result',
      requestId: worker.requestAt(3).requestId,
      relation: 'out',
      materialization: 'view',
      rowCount: 2,
    })

    expect(await pending).toEqual({
      status: 'completed',
      nodes: [
        { nodeId: 'customers', relation: 'customers', rowCount: 5, materialization: 'source' },
        { nodeId: 'sg', relation: 'sg', rowCount: 2, materialization: 'view' },
        { nodeId: 'out', relation: 'out', rowCount: 2, materialization: 'view' },
      ],
    })
  })

  it('refuses hostile verbatim SQL before any pipeline op crosses the boundary', async () => {
    const { client, workers } = makeClient()
    const pending = client.runPipeline({
      order: ['out'],
      nodes: [
        {
          nodeId: 'out',
          kind: 'sql',
          relation: 'out',
          quotedRelation: '"out"',
          sql: 'DROP TABLE customers',
          materialization: 'view',
          statement: 'CREATE OR REPLACE VIEW "out" AS DROP TABLE customers',
          statementKind: 'view',
        },
      ],
    })
    await flush()
    const worker = workers[0]!
    worker.respond(readyResponse(worker.requestAt(0).requestId))
    await expect(pending).rejects.toBeInstanceOf(PipelineRunRefusalError)
    await expect(pending).rejects.toMatchObject({ reason: 'forbidden-sql' })
    expect(worker.postedRequests.map((request) => request.type)).toEqual(['engine/init'])
  })

  it('reports a canceled outcome when the generation guard is invalidated', async () => {
    const { client, workers } = makeClient()
    const guard = new PipelineRunGuard()
    const pending = client.runPipeline(journeyPipeline(), {
      sources: [{ nodeId: 'customers', source: journeySource }],
      guard,
    })
    await flush()
    const worker = workers[0]!
    worker.respond(readyResponse(worker.requestAt(0).requestId))
    await flush()
    expect(worker.requestAt(1)).toMatchObject({ type: 'engine/pipeline-source' })
    guard.invalidate()
    worker.respond({
      type: 'engine/pipeline-source-result',
      requestId: worker.requestAt(1).requestId,
      relation: 'customers',
      rowCount: 5,
    })
    expect(await pending).toEqual({
      status: 'canceled',
      nodes: [
        { nodeId: 'customers', relation: 'customers', rowCount: 5, materialization: 'source' },
      ],
      nextNodeId: 'sg',
    })
    // No node op was sent after cancellation.
    expect(worker.postedRequests.map((request) => request.type)).toEqual([
      'engine/init',
      'engine/pipeline-source',
    ])
  })

  it('maps a mid-DAG engine rejection to a value-free node-attributed failure', async () => {
    const { client, workers } = makeClient()
    const pending = client.runPipeline(journeyPipeline(), {
      sources: [{ nodeId: 'customers', source: journeySource }],
    })
    await flush()
    const worker = workers[0]!
    worker.respond(readyResponse(worker.requestAt(0).requestId))
    await flush()
    worker.respond({
      type: 'engine/pipeline-source-result',
      requestId: worker.requestAt(1).requestId,
      relation: 'customers',
      rowCount: 5,
    })
    await flush()
    worker.respond({
      type: 'engine/error',
      requestId: worker.requestAt(2).requestId,
      message: 'Binder Error: SELECT raw SQL with customer values',
    })
    let error: unknown
    try {
      await pending
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(PipelineRunError)
    const failure = error as PipelineRunError
    expect(failure.nodeId).toBe('sg')
    expect(failure.partial).toEqual([{ nodeId: 'customers', relation: 'customers' }])
    // The raw engine text is dropped, never echoed.
    expect(failure.message).not.toContain('customer values')
  })

  it('drives an export node through engine/pipeline-execute (p2-4)', async () => {
    const { client, workers } = makeClient()
    const pipeline: PipelineV1 = {
      version: 1,
      pipeline: 'client-export',
      nodes: [
        { id: 'customers', type: 'source', source: { kind: 'file' } },
        {
          id: 'out',
          type: 'sql',
          materialization: 'export',
          inputs: ['customers'],
          sql: 'SELECT customer_id FROM customers',
        },
      ],
    }
    const pending = client.runPipeline(pipeline, {
      sources: [{ nodeId: 'customers', source: journeySource }],
    })
    await flush()
    const worker = workers[0]!
    worker.respond(readyResponse(worker.requestAt(0).requestId))
    await flush()
    worker.respond({
      type: 'engine/pipeline-source-result',
      requestId: worker.requestAt(1).requestId,
      relation: 'customers',
      rowCount: 5,
    })
    await flush()
    expect(worker.requestAt(2)).toMatchObject({
      type: 'engine/pipeline-execute',
      materialization: 'export',
    })
    worker.respond({
      type: 'engine/pipeline-execute-result',
      requestId: worker.requestAt(2).requestId,
      relation: 'out',
      materialization: 'export',
      rowCount: 5,
      path: 'assay-exports/assay-pipeline-export-out.parquet',
      bytes: 3,
    })
    const result = await pending
    expect(result.status).toBe('completed')
    if (result.status !== 'completed') return
    expect(result.nodes.find((node) => node.nodeId === 'out')?.exportPath).toBe(
      'assay-exports/assay-pipeline-export-out.parquet',
    )
  })

  it('runs a validate gate through the M5 wire path (p2-4)', async () => {
    const { client, workers } = makeClient()
    const pipeline: PipelineV1 = {
      version: 1,
      pipeline: 'client-gate',
      nodes: [
        { id: 'customers', type: 'source', source: { kind: 'file' } },
        { id: 'gate', type: 'validate', input: 'customers', contract: 'contracts/gate.yaml' },
      ],
    }
    const plan: EngineValidationPlan = {
      planKind: 'assay-validation-plan',
      planVersion: 1,
      contractName: 'gate',
      contractVersion: 1,
      relation: 'assay_pipeline_validation',
      sampleLimit: 20,
      rules: [
        {
          ruleId: 'columns[0].required',
          path: 'columns[0].required',
          kind: 'required',
          column: 'customer_id',
          outcome: 'row-samples',
          sql: 'SELECT 1',
        },
      ],
      summarySql: 'SELECT 1',
    }
    const pending = client.runPipeline(pipeline, {
      sources: [{ nodeId: 'customers', source: journeySource }],
      contracts: [{ nodeId: 'gate', contract: { fake: true } }],
      compilers: { validate: () => ({ ok: true, plan }) },
    })
    await flush()
    const worker = workers[0]!
    worker.respond(readyResponse(worker.requestAt(0).requestId))
    await flush()
    worker.respond({
      type: 'engine/pipeline-source-result',
      requestId: worker.requestAt(1).requestId,
      relation: 'customers',
      rowCount: 5,
    })
    await flush()
    expect(worker.requestAt(2)).toMatchObject({
      type: 'engine/pipeline-handle',
      relation: 'customers',
    })
    worker.respond({
      type: 'engine/pipeline-handle-result',
      requestId: worker.requestAt(2).requestId,
      relation: 'customers',
      tableId: 't1',
    })
    await flush()
    expect(worker.requestAt(3)).toMatchObject({ type: 'engine/schema', tableId: 't1' })
    worker.respond({
      type: 'engine/schema-result',
      requestId: worker.requestAt(3).requestId,
      columns: [{ name: 'customer_id', type: 'BIGINT' }],
    })
    await flush()
    expect(worker.requestAt(4)).toMatchObject({ type: 'engine/validate', tableId: 't1' })
    worker.respond({
      type: 'engine/validate-result',
      requestId: worker.requestAt(4).requestId,
      result: {
        valid: true,
        rowCount: 5,
        rules: [
          {
            ruleId: 'columns[0].required',
            outcome: 'row-samples',
            failCount: 0,
            failPercent: 0,
            sampleFailures: [],
          },
        ],
      },
    })
    const result = await pending
    expect(result.status).toBe('completed')
    if (result.status !== 'completed') return
    expect(result.nodes.find((node) => node.nodeId === 'gate')?.gate).toEqual({
      class: 'validate',
      input: 'customers',
      valid: true,
      violatedRules: 0,
    })
  })

  it('runs a diff node through engine/pipeline-diff (p2-4)', async () => {
    const { client, workers } = makeClient()
    const compiled = compileRowDiffPlan(
      [
        { name: 'customer_id', type: 'BIGINT' },
        { name: 'country', type: 'VARCHAR' },
      ],
      [
        { name: 'customer_id', type: 'BIGINT' },
        { name: 'country', type: 'VARCHAR' },
      ],
      ['customer_id'],
      { relationA: 'assay_pipeline_diff_a', relationB: 'assay_pipeline_diff_b' },
    )
    if (!compiled.ok) throw new Error('diff fixture compile failed')
    const pipeline: PipelineV1 = {
      version: 1,
      pipeline: 'client-diff',
      nodes: [
        { id: 'a', type: 'source', source: { kind: 'file' } },
        { id: 'b', type: 'source', source: { kind: 'file' } },
        { id: 'compare', type: 'diff', input: 'a', against: 'b' },
      ],
    }
    const pending = client.runPipeline(pipeline, {
      sources: [
        { nodeId: 'a', source: journeySource },
        { nodeId: 'b', source: journeySource },
      ],
      diffKeys: [{ nodeId: 'compare', keys: ['customer_id'] }],
      compilers: { diff: () => ({ ok: true, plan: compiled.plan }) },
    })
    await flush()
    const worker = workers[0]!
    worker.respond(readyResponse(worker.requestAt(0).requestId))
    await flush()
    let index = 1
    for (const relation of ['a', 'b']) {
      worker.respond({
        type: 'engine/pipeline-source-result',
        requestId: worker.requestAt(index).requestId,
        relation,
        rowCount: 2,
      })
      index += 1
      await flush()
    }
    // schemaOf for both relations: handle + schema each.
    for (const relation of ['a', 'b']) {
      expect(worker.requestAt(index)).toMatchObject({
        type: 'engine/pipeline-handle',
        relation,
      })
      worker.respond({
        type: 'engine/pipeline-handle-result',
        requestId: worker.requestAt(index).requestId,
        relation,
        tableId: `t-${relation}`,
      })
      index += 1
      await flush()
      worker.respond({
        type: 'engine/schema-result',
        requestId: worker.requestAt(index).requestId,
        columns: [
          { name: 'customer_id', type: 'BIGINT' },
          { name: 'country', type: 'VARCHAR' },
        ],
      })
      index += 1
      await flush()
    }
    expect(worker.requestAt(index)).toMatchObject({ type: 'engine/pipeline-diff' })
    worker.respond({
      type: 'engine/pipeline-diff-result',
      requestId: worker.requestAt(index).requestId,
      result: {
        rowCountA: 2,
        rowCountB: 2,
        aspects: [
          { aspect: 'added', count: 0, samples: [] },
          { aspect: 'removed', count: 0, samples: [] },
          { aspect: 'changed', count: 0, samples: [] },
        ],
      },
    })
    const result = await pending
    expect(result.status).toBe('completed')
    if (result.status !== 'completed') return
    expect(result.nodes.find((node) => node.nodeId === 'compare')?.gate).toEqual({
      class: 'diff',
      input: 'a',
      against: 'b',
      added: 0,
      removed: 0,
      changed: 0,
    })
  })

  it('reuses one gate handle per relation per run and registers fresh across consecutive runs (p2c-2 (d))', async () => {
    // The m6-4-era registry-accumulation concern, for pipeline gates: a
    // long-lived session runs a gated pipeline repeatedly. The client keeps
    // ONE handle per relation per run (`handleFor`'s run-local memo) — the
    // same relation must not be re-registered once per gate — and each run
    // registers a FRESH handle rather than carrying a stale one over. No
    // accumulation may break a later run.
    const { client, workers } = makeClient()
    const pipeline: PipelineV1 = {
      version: 1,
      pipeline: 'client-gate-reuse',
      nodes: [
        { id: 'customers', type: 'source', source: { kind: 'file' } },
        {
          id: 'sg',
          type: 'transform',
          inputs: ['customers'],
          operation: {
            operation: 'filter',
            args: { predicates: [{ column: 'country', operator: 'equals', value: 'SG' }] },
          },
        },
        { id: 'gateA', type: 'validate', input: 'sg', contract: 'contracts/gate-a.yaml' },
        { id: 'gateB', type: 'validate', input: 'sg', contract: 'contracts/gate-b.yaml' },
        { id: 'out', type: 'publish', input: 'sg', requires: ['gateA', 'gateB'] },
      ],
    }
    const plan: EngineValidationPlan = {
      planKind: 'assay-validation-plan',
      planVersion: 1,
      contractName: 'gate',
      contractVersion: 1,
      relation: 'assay_pipeline_validation',
      sampleLimit: 20,
      rules: [
        {
          ruleId: 'columns[0].required',
          path: 'columns[0].required',
          kind: 'required',
          column: 'customer_id',
          outcome: 'row-samples',
          sql: 'SELECT 1',
        },
      ],
      summarySql: 'SELECT 1',
    }
    const options: PipelineRunOptions = {
      sources: [{ nodeId: 'customers', source: journeySource }],
      contracts: [
        { nodeId: 'gateA', contract: { fake: true } },
        { nodeId: 'gateB', contract: { fake: true } },
      ],
      compilers: { validate: () => ({ ok: true, plan }) },
    }
    // pass → pass: two runs, each with TWO gates on the same `sg` relation.
    const first = await driveClientRun(client, workers, pipeline, options, 0, [true, true], 't1')
    expect(first.result.status).toBe('completed')
    // One handle per relation per run, despite two gate probes of `sg`.
    expect(first.handleRequests).toBe(1)

    const second = await driveClientRun(
      client,
      workers,
      pipeline,
      options,
      first.endIndex,
      [true, true],
      't2',
    )
    expect(second.result.status).toBe('completed')
    // A fresh handle for the second run — never a stale one carried over.
    expect(second.handleRequests).toBe(1)

    // fail → fixed-rerun: gateA fails, the publish blocks on gateA only.
    const gated = await driveClientRun(
      client,
      workers,
      pipeline,
      options,
      second.endIndex,
      [false, true],
      't3',
    )
    expect(gated.result.status).toBe('gated')
    expect(gated.handleRequests).toBe(1)
    if (gated.result.status !== 'gated') return
    expect(gated.result.nodes.find((node) => node.nodeId === 'out')?.gate).toEqual({
      class: 'publish',
      input: 'sg',
      blockedGates: ['gateA'],
    })

    const fixed = await driveClientRun(
      client,
      workers,
      pipeline,
      options,
      gated.endIndex,
      [true, true],
      't4',
    )
    expect(fixed.result.status).toBe('completed')
    expect(fixed.handleRequests).toBe(1)

    // Four consecutive runs in one session → exactly four handle
    // registrations (one per run), never the per-gate accumulation the
    // run-local memo prevents.
    const bootedWorker = workers[0]
    if (bootedWorker === undefined) throw new Error('the client never booted a worker')
    expect(
      bootedWorker.postedRequests.filter((request) => request.type === 'engine/pipeline-handle'),
    ).toHaveLength(4)
  })
})

// EW-03I: client csvPreview + open options (the host-side validation pass)
// ─────────────────────────────────────────────────────────────────────────────

describe('DuckDbEngineClient csvPreview + open options (EW-03I)', () => {
  const csvFile = new File([new Uint8Array([1, 2, 3])], 'candidate.csv')
  const csvSource = { name: 'candidate.csv', getFile: () => Promise.resolve(csvFile) }

  function sniffPayload(): EngineCsvSniff {
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

  function previewResultResponse(
    requestId: number,
    sample: EngineCsvPreviewSample | null,
  ): EngineResponse {
    return {
      type: 'engine/csv-preview-result',
      requestId,
      previewId: 'p1',
      sniff: sniffPayload(),
      effectiveOptions: { delim: ';' },
      // A real Arrow IPC payload so the client's reconstitution is exercised.
      sample,
    }
  }

  it('csvPreview sends the typed request with canonical options and reconstitutes the sample batch', async () => {
    const { client, workers } = makeClient()
    const batchIpc = tableToIPC(tableFromArrays({ id: ['0017'], amount: [10.5] }))
    const pending = client.csvPreview(csvSource, { sep: ';' }, 25)
    const worker = workers[0]!
    worker.respond(readyResponse(worker.requestAt(0).requestId))
    await flush()
    const request = worker.requestAt(1)
    expect(request).toMatchObject({ type: 'engine/csv-preview', name: 'candidate.csv' })
    if (request.type !== 'engine/csv-preview') throw new Error('unreachable')
    // The sep alias resolved to delim BEFORE sending (the canonical wire form).
    expect(request.options).toEqual({ delim: ';' })
    expect(request.sampleRows).toBe(25)
    worker.respond(
      previewResultResponse(request.requestId, {
        batchIpc,
        hasMore: false,
        rowCap: 25,
      }),
    )

    const result = await pending
    expect(result.previewId).toBe('p1')
    expect(result.sniff).toEqual(sniffPayload())
    expect(result.effectiveOptions).toEqual({ delim: ';' })
    expect(result.sample).not.toBeNull()
    if (result.sample !== null) {
      expect(result.sample.rowCap).toBe(25)
      expect(result.sample.hasMore).toBe(false)
      expect(result.sample.batch.numRows).toBe(1)
      expect(result.sample.batch.getChild('id')?.get(0)).toBe('0017')
    }
  })

  it('csvPreview without sampleRows omits the field (the worker applies its cap); sampleRows 0 returns a null sample', async () => {
    const { client, workers } = makeClient()
    const pending = client.csvPreview(csvSource, { all_varchar: true })
    const worker = workers[0]!
    worker.respond(readyResponse(worker.requestAt(0).requestId))
    await flush()
    const request = worker.requestAt(1)
    if (request.type !== 'engine/csv-preview') throw new Error('unreachable')
    expect(request.sampleRows).toBeUndefined()
    worker.respond(previewResultResponse(request.requestId, null))
    const result = await pending
    expect(result.sample).toBeNull()
  })

  it('csvPreview refuses a non-csv source and an out-of-vocabulary option BEFORE anything crosses the boundary', async () => {
    const { client, workers } = makeClient()
    const parquetSource = {
      name: 'flat.parquet',
      getFile: () => Promise.resolve(new File([], 'flat.parquet')),
    }
    // The expectation attaches synchronously (no unhandled-rejection window);
    // the refusals sit behind the lazy boot, answered right below.
    const expectation = expect(client.csvPreview(parquetSource)).rejects.toThrow(
      'csv preview requires a .csv file: this op reviews the CSV reader only',
    )
    workers[0]!.respond(readyResponse(workers[0]!.requestAt(0).requestId))
    await flush()
    await expectation
    // Ready is memoized now — later refusals are immediate.
    await expect(client.csvPreview(csvSource, { ignore_errors: true })).rejects.toThrow(
      'refused CSV option: ignore_errors',
    )
    await expect(client.csvPreview(csvSource, { delimiter: ',' })).rejects.toThrow(
      'refused CSV option: delimiter',
    )
    // Nothing was ever posted for the refusals (no preview request exists).
    expect(
      workers[0]!.postedRequests.filter((request) => request.type === 'engine/csv-preview'),
    ).toHaveLength(0)
  })

  it('open with options validates the vocabulary client-side and sends the canonical set', async () => {
    const { client, workers } = makeClient()
    const pending = client.open(csvSource, { types: { v: 'VARCHAR' }, header: true })
    const worker = workers[0]!
    worker.respond(readyResponse(worker.requestAt(0).requestId))
    await flush()
    const request = worker.requestAt(1)
    expect(request).toMatchObject({ type: 'engine/open', name: 'candidate.csv', file: csvFile })
    if (request.type !== 'engine/open') throw new Error('unreachable')
    expect(request.options).toEqual({ columns: { v: 'VARCHAR' }, header: true })
    worker.respond({
      type: 'engine/open-result',
      requestId: request.requestId,
      tableId: 't1',
      format: 'csv',
    })
    expect(await pending).toEqual({ kind: 'table', id: 't1' })
  })

  it('open without options sends the legacy request shape (no options key at all)', async () => {
    const { client, workers } = makeClient()
    const pending = client.open(csvSource)
    const worker = workers[0]!
    worker.respond(readyResponse(worker.requestAt(0).requestId))
    await flush()
    const request = worker.requestAt(1)
    expect(request).toMatchObject({ type: 'engine/open', name: 'candidate.csv' })
    expect('options' in request).toBe(false)
    worker.respond({
      type: 'engine/open-result',
      requestId: request.requestId,
      tableId: 't1',
      format: 'csv',
    })
    await pending
  })

  it('open refusals happen before send: preview-only sample_size, non-csv file, deferred key', async () => {
    const { client, workers } = makeClient()
    const parquetSource = {
      name: 'flat.parquet',
      getFile: () => Promise.resolve(new File([], 'flat.parquet')),
    }
    const expectation = expect(client.open(csvSource, { sample_size: 10 })).rejects.toThrow(
      'sample_size is a preview-only option and cannot ride engine/open',
    )
    workers[0]!.respond(readyResponse(workers[0]!.requestAt(0).requestId))
    await flush()
    await expectation
    await expect(client.open(parquetSource, { delim: ';' })).rejects.toThrow(
      'csv options require a .csv file: the other readers take no options',
    )
    await expect(client.open(csvSource, { strict_mode: true })).rejects.toThrow('strict_mode')
    await expect(client.open(csvSource, { delimiter: ',' })).rejects.toThrow(
      'refused CSV option: delimiter',
    )
    expect(
      workers[0]!.postedRequests.filter((request) => request.type === 'engine/open'),
    ).toHaveLength(0)
  })
})
