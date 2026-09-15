import { tableFromArrays, tableToIPC } from 'apache-arrow'
import { describe, expect, it } from 'vitest'
import {
  DuckDbEngineClient,
  EngineDisposedError,
  EngineProtocolError,
  EngineQueryError,
  type EngineQueryResult,
  type EngineWorkerFactory,
  type EngineWorkerLike,
} from './client'
import type { EngineRequest, EngineResponse } from './protocol'

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

function makeClient(): { client: DuckDbEngineClient; workers: FakeWorker[] } {
  FakeWorker.instances.length = 0
  const factory: EngineWorkerFactory = () => new FakeWorker()
  return {
    client: new DuckDbEngineClient({ workerFactory: factory }),
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

  it('dispose terminates the worker, fails pending work, and is terminal', async () => {
    const { client, workers } = makeClient()

    const pending = client.query('SELECT 42 AS value')
    const worker = workers[0]!
    client.dispose()

    await expect(pending).rejects.toThrow(EngineDisposedError)
    expect(client.status).toBe('disposed')
    expect(worker.terminated).toBe(true)
    await expect(client.query('SELECT 42 AS value')).rejects.toThrow(EngineDisposedError)
    await expect(client.ensureReady()).rejects.toThrow(EngineDisposedError)
    // A boot racing dispose must not resurrect the disposed status.
    await flush()
    expect(client.status).toBe('disposed')
  })
})
