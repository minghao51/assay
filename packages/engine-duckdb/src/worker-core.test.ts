// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Headless pins for the bundler-agnostic worker seam (ptv1-1).
 *
 * Two sides are pinned here, in the committed-pin style of
 * `engine-target-compat.test.ts` (assertions whose failure means a silent
 * contract drift, not a style preference):
 *
 * 1. The DEFAULT WEB PATH is unchanged by the seam's introduction:
 *    `defaultWorkerFactory` still constructs the Vite worker entry with
 *    `{ type: 'module' }` exactly as before (pin 1), and a client booted with
 *    default options posts exactly one `engine/init` and nothing else — the
 *    seam adds no messages to the web path (pin 2).
 * 2. The INJECTION LOGIC a webview host relies on: a core started with
 *    `{ source: 'injected' }` boots DuckDB from the `engine/assets` control
 *    message's blob URLs (pin 3), parks — without hanging or booting — if a
 *    request races ahead of the assets message (pin 4), swallows repeated
 *    assets messages instead of double-booting (pin 5), and a static-mode core
 *    forwards every message to the executor untouched (pin 6 — a stray
 *    `engine/assets` there is an unknown no-requestId envelope, which the
 *    protocol ignores silently).
 *
 * DuckDB-WASM is mocked: the core must only ever call
 * `new Worker(duckdbWorkerUrl)` + `instantiate(duckdbWasmUrl)` with the URLs
 * from the seam — that is exactly what these pins assert.
 */
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest'
import { DuckDbEngineClient, defaultWorkerFactory, type EngineWorkerLike } from './client.js'
import type { EngineResponse } from './protocol.js'
import {
  isEngineAssetsMessage,
  startEngineWorkerCore,
  type EngineAssetsMessage,
  type EngineWorkerCoreAssets,
  type EngineWorkerScope,
} from './worker-core.js'

// ---- DuckDB-WASM mock (records the URLs the core actually boots from) -----

const duckdbMock = vi.hoisted(() => ({
  /** URLs passed to `new Worker(...)` for the DuckDB glue script. */
  workerUrls: [] as string[],
  /** URLs passed to `AsyncDuckDB.instantiate` (the WASM module). */
  instantiateUrls: [] as string[],
  version: 'v1.32.0-pintest',
}))

vi.mock('@duckdb/duckdb-wasm', () => ({
  // The core only constructs the logger and hands it to AsyncDuckDB.
  VoidLogger: class {
    /* duckdb's no-op logger */
  },
  AsyncDuckDB: class {
    constructor(_logger: unknown, worker: { url?: string }) {
      duckdbMock.workerUrls.push(String(worker.url ?? ''))
    }
    async instantiate(url: string): Promise<void> {
      duckdbMock.instantiateUrls.push(url)
    }
    async connect(): Promise<unknown> {
      // The core stores one connection per lane (m2-7) but an `engine/init`
      // boot never issues connection work, so an empty structural stub is
      // enough for these pins.
      return {}
    }
    async getVersion(): Promise<string> {
      return duckdbMock.version
    }
    async terminate(): Promise<void> {
      /* best-effort teardown path, not exercised by these pins */
    }
  },
}))

// ---- Fake glue worker (the `new Worker(url)` the core performs) -----------

class FakeGlueWorker {
  static readonly urls: string[] = []
  readonly url: string
  constructor(url: string) {
    this.url = url
    FakeGlueWorker.urls.push(url)
  }
  terminate(): void {}
}

// ---- Fake worker scope (captures the core's posts and delivers messages) --

class FakeScope implements EngineWorkerScope {
  readonly posted: EngineResponse[] = []
  private readonly listeners: Array<(event: MessageEvent<unknown>) => void> = []

  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void {
    if (type === 'message') this.listeners.push(listener)
  }

  postMessage(response: EngineResponse): void {
    this.posted.push(response)
  }

  /** Deliver a message to the core (the worker's message event). */
  dispatch(data: unknown): void {
    for (const listener of this.listeners) {
      listener(new MessageEvent('message', { data }))
    }
  }
}

/** Flush microtasks queued by promise continuations (macrotask boundary). */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function assetsMessage(duckdbWorkerUrl: string, duckdbWasmUrl: string): EngineAssetsMessage {
  return { type: 'engine/assets', duckdbWorkerUrl, duckdbWasmUrl }
}

function resetRecorders(): void {
  duckdbMock.workerUrls.length = 0
  duckdbMock.instantiateUrls.length = 0
  FakeGlueWorker.urls.length = 0
}

beforeEach(() => {
  // The core constructs the DuckDB glue worker with a bare `new Worker(url)`;
  // the fake records the URL so the pins can assert exactly what was booted.
  vi.stubGlobal('Worker', FakeGlueWorker)
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetRecorders()
})

// ---- 1. The default web path (byte-identical pins) ------------------------

describe('defaultWorkerFactory (the web default, ptv1-1 seam)', () => {
  it('constructs the Vite worker entry with { type: "module" } — the exact pre-seam construction', () => {
    let capturedUrl = ''
    let capturedOptions: WorkerOptions | undefined = undefined
    class CapturingWorker implements EngineWorkerLike {
      constructor(url: string, options?: WorkerOptions) {
        capturedUrl = url
        capturedOptions = options
      }
      postMessage(): void {}
      terminate(): void {}
      addEventListener(): void {}
    }
    vi.stubGlobal('Worker', CapturingWorker)
    defaultWorkerFactory()
    expect(new URL(capturedUrl).pathname.endsWith('/src/worker.ts')).toBe(true)
    expect(capturedOptions).toEqual({ type: 'module' })
  })
})

describe('default client boot (no injected seam on the web path)', () => {
  it('posts exactly one engine/init and no engine/assets message', async () => {
    expect.assertions(2)
    const posted: string[] = []
    class InitFirstFakeWorker implements EngineWorkerLike {
      postMessage(request: { type: string }): void {
        posted.push(request.type)
      }
      terminate(): void {}
      addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void
      addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void
      addEventListener(
        type: 'message' | 'error',
        listener: ((event: MessageEvent<unknown>) => void) | ((event: ErrorEvent) => void),
      ): void {
        if (type !== 'message') return
        // Answer init so the boot settles; the assertion is the posted list.
        queueMicrotask(() => {
          ;(listener as (event: MessageEvent<unknown>) => void)(
            new MessageEvent('message', {
              data: { type: 'engine/ready', requestId: 1, duckdbVersion: 'v9.9.9-pin' },
            }),
          )
        })
      }
    }
    const client = new DuckDbEngineClient({ workerFactory: () => new InitFirstFakeWorker() })
    await client.ensureReady()
    // The whole point of the seam: the default path posts init FIRST and ONLY.
    expect(posted).toEqual(['engine/init'])
    expect(posted.includes('engine/assets')).toBe(false)
  })
})

// ---- 2. The injection logic (the webview host's contract) -----------------

describe('startEngineWorkerCore({ source: "injected" })', () => {
  it('boots DuckDB from the engine/assets blob URLs and replies engine/ready', async () => {
    const scope = new FakeScope()
    startEngineWorkerCore({ source: 'injected' }, scope)

    scope.dispatch(assetsMessage('blob:https://host/glue', 'blob:https://host/wasm'))
    scope.dispatch({ type: 'engine/init', requestId: 7 })
    await flush()

    expect(FakeGlueWorker.urls).toEqual(['blob:https://host/glue'])
    expect(duckdbMock.instantiateUrls).toEqual(['blob:https://host/wasm'])
    expect(scope.posted).toEqual([
      { type: 'engine/ready', requestId: 7, duckdbVersion: duckdbMock.version },
    ])
  })

  it('parks a request that races ahead of the assets message, then boots once it arrives', async () => {
    const scope = new FakeScope()
    startEngineWorkerCore({ source: 'injected' }, scope)

    // Init first — the host is expected to post assets first, so this order
    // must degrade to a wait, never to a hang or a boot from empty URLs.
    scope.dispatch({ type: 'engine/init', requestId: 1 })
    await flush()
    expect(FakeGlueWorker.urls).toEqual([])
    expect(scope.posted).toEqual([])

    scope.dispatch(assetsMessage('blob:late/glue', 'blob:late/wasm'))
    await flush()

    expect(FakeGlueWorker.urls).toEqual(['blob:late/glue'])
    expect(duckdbMock.instantiateUrls).toEqual(['blob:late/wasm'])
    expect(scope.posted).toEqual([
      { type: 'engine/ready', requestId: 1, duckdbVersion: duckdbMock.version },
    ])
  })

  it('swallows repeated engine/assets messages (the seam resolves exactly once)', async () => {
    const scope = new FakeScope()
    startEngineWorkerCore({ source: 'injected' }, scope)

    scope.dispatch(assetsMessage('blob:first/glue', 'blob:first/wasm'))
    scope.dispatch(assetsMessage('blob:second/glue', 'blob:second/wasm'))
    scope.dispatch({ type: 'engine/init', requestId: 3 })
    await flush()

    expect(FakeGlueWorker.urls).toEqual(['blob:first/glue'])
    expect(duckdbMock.instantiateUrls).toEqual(['blob:first/wasm'])
    expect(scope.posted).toEqual([
      { type: 'engine/ready', requestId: 3, duckdbVersion: duckdbMock.version },
    ])
  })
})

describe('startEngineWorkerCore({ source: "static" }) — the web entry mode', () => {
  it('boots from the static URLs and forwards stray non-protocol messages untouched', async () => {
    const scope = new FakeScope()
    const assets: EngineWorkerCoreAssets = {
      source: 'static',
      urls: {
        duckdbWorkerUrl: 'https://cdn/duckdb-browser-mvp.worker.js',
        duckdbWasmUrl: 'https://cdn/duckdb-mvp.wasm',
      },
    }
    startEngineWorkerCore(assets, scope)

    // A stray injected-seam control message is NOT special-cased in static
    // mode: it reaches the executor as an unknown no-requestId envelope, which
    // the protocol ignores silently (no error post, no crash) — exactly the
    // pre-extraction worker's behavior for unrecognized messages.
    scope.dispatch(assetsMessage('blob:should-be-ignored/glue', 'blob:should-be-ignored/wasm'))
    scope.dispatch({ type: 'engine/init', requestId: 9 })
    await flush()

    expect(FakeGlueWorker.urls).toEqual(['https://cdn/duckdb-browser-mvp.worker.js'])
    expect(duckdbMock.instantiateUrls).toEqual(['https://cdn/duckdb-mvp.wasm'])
    expect(scope.posted).toEqual([
      { type: 'engine/ready', requestId: 9, duckdbVersion: duckdbMock.version },
    ])
  })
})

describe('engine/assets message guard', () => {
  it('accepts only the exact control-message shape', () => {
    expect(isEngineAssetsMessage(assetsMessage('a', 'b'))).toBe(true)
    expect(isEngineAssetsMessage({ type: 'engine/assets', duckdbWorkerUrl: 'a' })).toBe(false)
    expect(isEngineAssetsMessage({ type: 'engine/assets' })).toBe(false)
    expect(isEngineAssetsMessage({ type: 'engine/init', requestId: 1 })).toBe(false)
    expect(isEngineAssetsMessage(null)).toBe(false)
    expect(isEngineAssetsMessage('engine/assets')).toBe(false)
  })
})

// ---- 3. Type-level pins (engine-target-compat pattern) --------------------

/** Compiles only when `Source` is assignable to `Target` (a failed relation is TS2344 at the use site). */
type AssignableTo<Target, Source extends Target> = Source

/**
 * The seam's surface pins: the wire message requires BOTH URL fields with the
 * literal `engine/assets` type (a typo'd field name or type string fails
 * `tsc`, not just the runtime guard), and both asset-source variants are
 * constructible as declared.
 */
export type WorkerSeamTypePins = [
  AssignableTo<
    { type: 'engine/assets'; duckdbWorkerUrl: string; duckdbWasmUrl: string },
    EngineAssetsMessage
  >,
  AssignableTo<EngineAssetsMessage, EngineAssetsMessage>,
  AssignableTo<
    EngineWorkerCoreAssets,
    { source: 'static'; urls: { duckdbWorkerUrl: string; duckdbWasmUrl: string } }
  >,
  AssignableTo<EngineWorkerCoreAssets, { source: 'injected' }>,
]
