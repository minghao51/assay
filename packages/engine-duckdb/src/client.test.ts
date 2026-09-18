import { tableFromArrays, tableToIPC } from 'apache-arrow'
import { describe, expect, it } from 'vitest'
import { baseRowId } from '@assay/domain'
import {
  DuckDbEngineClient,
  EngineDisposedError,
  EngineOperationError,
  EngineProtocolError,
  EngineQueryError,
  type EngineQueryResult,
  type EngineWorkerFactory,
  type EngineWorkerLike,
} from './client'
import type { DuckDbEngineClientOptions } from './client'
import type {
  EngineColumnSchema,
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
})
