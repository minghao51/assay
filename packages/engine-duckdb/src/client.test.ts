import { describe, expect, it } from 'vitest'
import {
  DuckDbEngineClient,
  EngineDisposedError,
  EngineQueryError,
  type EngineWorkerFactory,
  type EngineWorkerLike,
} from './client'
import type { EngineRequest, EngineResponse } from './protocol'

/**
 * In-memory fake for the worker boundary. It records posted requests and lets
 * tests deliver responses/error events by hand, so the lazy-init state
 * machine is exercised without a real Worker (DuckDB-WASM needs a browser —
 * the real proof is the Playwright e2e).
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

function readyResponse(requestId: number): EngineResponse {
  return { type: 'engine/ready', requestId, duckdbVersion: 'v9.9.9-test' }
}

function queryResultResponse(
  requestId: number,
  rows: Array<Array<null | number | string>>,
): EngineResponse {
  return {
    type: 'engine/query-result',
    requestId,
    result: {
      columns: rows.length > 0 ? rows[0]!.map((_, i) => `col${i}`) : [],
      rowCount: rows.length,
      rows,
      truncated: false,
    },
  }
}

describe('DuckDbEngineClient lazy bootstrap', () => {
  it('constructs idle without touching the worker factory', () => {
    const { client, workers } = makeClient()
    expect(client.status).toBe('idle')
    expect(workers).toHaveLength(0)
  })

  it('boots exactly one worker on first use, then reuses it', async () => {
    const { client, workers } = makeClient()

    const first = client.query('SELECT 42')
    expect(client.status).toBe('booting')
    expect(workers).toHaveLength(1)
    const worker = workers[0]!
    expect(worker.postedRequests.map((r) => r.type)).toEqual(['engine/init'])
    expect(worker.terminated).toBe(false)

    worker.respond(readyResponse(worker.requestAt(0).requestId))
    await flush()
    expect(client.status).toBe('ready')
    expect(worker.postedRequests[1]).toMatchObject({ type: 'engine/query', sql: 'SELECT 42' })

    worker.respond(queryResultResponse(worker.requestAt(1).requestId, [[42]]))
    await expect(first).resolves.toEqual({
      columns: ['col0'],
      rowCount: 1,
      rows: [[42]],
      truncated: false,
    })

    const second = client.query('SELECT 1')
    await flush()
    expect(workers).toHaveLength(1) // same worker, no re-boot
    expect(worker.postedRequests[2]).toMatchObject({ type: 'engine/query', sql: 'SELECT 1' })
    worker.respond(queryResultResponse(worker.requestAt(2).requestId, [[1]]))
    await expect(second).resolves.toMatchObject({ rows: [[1]] })
  })

  it('coalesces concurrent first calls into one boot', async () => {
    const { client, workers } = makeClient()

    const [a, b] = [client.query('SELECT 1'), client.query('SELECT 2')]
    expect(workers).toHaveLength(1)
    const worker = workers[0]!
    expect(worker.postedRequests.filter((r) => r.type === 'engine/init')).toHaveLength(1)

    worker.respond(readyResponse(worker.requestAt(0).requestId))
    await flush()
    const queryIds = worker.postedRequests
      .filter((r) => r.type === 'engine/query')
      .map((r) => r.requestId)
    expect(queryIds).toHaveLength(2)

    worker.respond(queryResultResponse(queryIds[0]!, [[1]]))
    worker.respond(queryResultResponse(queryIds[1]!, [[2]]))
    await expect(a).resolves.toMatchObject({ rows: [[1]] })
    await expect(b).resolves.toMatchObject({ rows: [[2]] })
  })

  it('fails the boot on a worker crash, then retries with a fresh worker', async () => {
    const { client, workers } = makeClient()

    const doomed = client.query('SELECT 1')
    const crashed = workers[0]!
    crashed.crash('wasm exploded')
    await expect(doomed).rejects.toThrow(/wasm exploded/)
    expect(client.status).toBe('failed')
    expect(crashed.terminated).toBe(true)

    const retried = client.query('SELECT 1')
    expect(workers).toHaveLength(2)
    const fresh = workers[1]!
    expect(fresh).not.toBe(crashed)
    fresh.respond(readyResponse(fresh.requestAt(0).requestId))
    await flush()
    fresh.respond(queryResultResponse(fresh.requestAt(1).requestId, [[1]]))
    await expect(retried).resolves.toMatchObject({ rows: [[1]] })
    expect(client.status).toBe('ready')
  })

  it('rejects an init answered with an error response and stays retryable', async () => {
    const { client, workers } = makeClient()

    const doomed = client.query('SELECT 1')
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

    const pending = client.query('SELECT 42')
    const worker = workers[0]!
    worker.respondRaw({ hello: 'world' })
    worker.respondRaw(null)
    await flush()
    expect(worker.postedRequests).toHaveLength(1) // still waiting for init

    worker.respond(readyResponse(worker.requestAt(0).requestId))
    await flush()
    worker.respond(queryResultResponse(worker.requestAt(1).requestId, [[42]]))
    await expect(pending).resolves.toMatchObject({ rows: [[42]] })
  })

  it('dispose terminates the worker, fails pending work, and is terminal', async () => {
    const { client, workers } = makeClient()

    const pending = client.query('SELECT 42')
    const worker = workers[0]!
    client.dispose()

    await expect(pending).rejects.toThrow(EngineDisposedError)
    expect(client.status).toBe('disposed')
    expect(worker.terminated).toBe(true)
    await expect(client.query('SELECT 42')).rejects.toThrow(EngineDisposedError)
    await expect(client.ensureReady()).rejects.toThrow(EngineDisposedError)
    // A boot racing dispose must not resurrect the disposed status.
    await flush()
    expect(client.status).toBe('disposed')
  })
})
