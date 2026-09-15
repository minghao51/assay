/**
 * Main-thread client for the DuckDB engine worker.
 *
 * Laziness contract: constructing the client performs no work and touches no
 * platform APIs. The first `ensureReady()` / `query()` boots the engine
 * inside a dedicated Web Worker (ADR 0021) — DuckDB-WASM never runs on the
 * main thread. The main thread exchanges only the typed messages defined in
 * `./protocol`.
 */
import { parseEngineResponse } from './protocol'
import type {
  EngineQueryResult,
  EngineReadyInfo,
  EngineRequest,
  EngineSuccessResponse,
} from './protocol'

/** Lifecycle of the lazy engine bootstrap. */
export type EngineStatus = 'idle' | 'booting' | 'ready' | 'failed' | 'disposed'

/** The slice of the `Worker` API the client relies on (kept narrow for fakes). */
export interface EngineWorkerLike {
  postMessage(request: EngineRequest): void
  terminate(): void
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void
}

/** Creates the engine worker. Injectable so tests can fake the boundary. */
export type EngineWorkerFactory = () => EngineWorkerLike

export interface DuckDbEngineClientOptions {
  workerFactory?: EngineWorkerFactory
}

/** The engine worker failed, crashed, or is not running. */
export class EngineWorkerError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'EngineWorkerError'
  }
}

/** The worker sent a message that does not fit the protocol. */
export class EngineProtocolError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'EngineProtocolError'
  }
}

/** A request failed inside the engine worker (e.g. a SQL error). */
export class EngineQueryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'EngineQueryError'
  }
}

/** The operation was attempted after `dispose()`. */
export class EngineDisposedError extends Error {
  constructor(message = 'engine client was disposed') {
    super(message)
    this.name = 'EngineDisposedError'
  }
}

interface PendingRequest {
  kind: 'init' | 'query'
  resolve: (response: EngineSuccessResponse) => void
  reject: (error: Error) => void
}

/** Creates the real engine worker: this package's TS worker entry (bundled by Vite). */
function defaultWorkerFactory(): EngineWorkerLike {
  return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
}

export class DuckDbEngineClient {
  private currentStatus: EngineStatus = 'idle'
  private worker: EngineWorkerLike | null = null
  private readonly pending = new Map<number, PendingRequest>()
  private nextRequestId = 1
  private ready: Promise<EngineReadyInfo> | null = null
  private readonly workerFactory: EngineWorkerFactory

  constructor(options: DuckDbEngineClientOptions = {}) {
    this.workerFactory = options.workerFactory ?? defaultWorkerFactory
  }

  /** Current lifecycle state of the lazy bootstrap. */
  get status(): EngineStatus {
    return this.currentStatus
  }

  /**
   * Boot the engine worker if it is not running yet. Concurrent calls share a
   * single boot; after a failed boot (or a worker crash) the next call boots
   * a fresh worker.
   */
  async ensureReady(): Promise<EngineReadyInfo> {
    if (this.currentStatus === 'disposed') throw new EngineDisposedError()
    this.ready ??= this.boot()
    return this.ready
  }

  /**
   * Run a SQL query and return its bounded, scalar result. The scalar rows
   * are a temporary M1-1 surface — M1-2 replaces them with an Arrow
   * record-batch transport (ADR 0020).
   */
  async query(sql: string): Promise<EngineQueryResult> {
    await this.ensureReady()
    const response = await this.send({ type: 'engine/query', requestId: this.takeRequestId(), sql })
    if (response.type !== 'engine/query-result') {
      throw new EngineProtocolError(`unexpected ${response.type} response for engine/query`)
    }
    return response.result
  }

  /** Terminate the worker and fail every pending request. Terminal. */
  dispose(): void {
    if (this.currentStatus === 'disposed') return
    this.failAllPending(new EngineDisposedError())
    this.worker?.terminate()
    this.worker = null
    this.ready = null
    this.currentStatus = 'disposed'
  }

  private async boot(): Promise<EngineReadyInfo> {
    try {
      const worker = this.workerFactory()
      this.worker = worker
      worker.addEventListener('message', this.handleMessage)
      worker.addEventListener('error', this.handleError)
      this.currentStatus = 'booting'
      const response = await this.send({
        type: 'engine/init',
        requestId: this.takeRequestId(),
      })
      if (response.type !== 'engine/ready') {
        throw new EngineProtocolError(`unexpected ${response.type} response for engine/init`)
      }
      this.currentStatus = 'ready'
      return { duckdbVersion: response.duckdbVersion }
    } catch (error) {
      // Boot failed: tear down so the next call attempts a fresh boot.
      this.failAllPending(new EngineWorkerError('engine boot failed', { cause: error }))
      this.worker?.terminate()
      this.worker = null
      this.ready = null
      if (this.currentStatus !== 'disposed') this.currentStatus = 'failed'
      throw error
    }
  }

  private send(request: EngineRequest): Promise<EngineSuccessResponse> {
    const worker = this.worker
    if (worker === null) {
      return Promise.reject(new EngineWorkerError('engine worker is not running'))
    }
    return new Promise<EngineSuccessResponse>((resolve, reject) => {
      this.pending.set(request.requestId, {
        kind: request.type === 'engine/init' ? 'init' : 'query',
        resolve,
        reject,
      })
      worker.postMessage(request)
    })
  }

  private takeRequestId(): number {
    return this.nextRequestId++
  }

  private readonly handleMessage = (event: MessageEvent<unknown>): void => {
    const response = parseEngineResponse(event.data)
    if (response === null) {
      // Not our protocol (e.g. a foreign script sharing the worker) — ignore.
      return
    }
    const pending = this.pending.get(response.requestId)
    if (pending === undefined) {
      // Late or duplicate reply (e.g. after a crash + re-boot) — nothing to do.
      return
    }
    this.pending.delete(response.requestId)
    if (response.type === 'engine/error') {
      const error =
        pending.kind === 'query'
          ? new EngineQueryError(response.message)
          : new EngineWorkerError(response.message)
      pending.reject(error)
    } else {
      pending.resolve(response)
    }
  }

  private readonly handleError = (event: ErrorEvent): void => {
    // The worker itself died. Fail everything pending; an in-flight boot
    // rejects in its own catch and resets the client.
    this.crash(event.message || 'engine worker crashed')
  }

  private crash(reason: string): void {
    this.failAllPending(new EngineWorkerError(reason))
    this.worker?.terminate()
    this.worker = null
    this.ready = null
    if (this.currentStatus !== 'disposed') this.currentStatus = 'failed'
  }

  private failAllPending(reason: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(reason)
    }
    this.pending.clear()
  }
}
