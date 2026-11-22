// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from 'vitest'
import type { TelemetryEvent } from '@assay/telemetry'
import { createFetchTransport } from './transport'

function event(): TelemetryEvent {
  return {
    schema_version: 1,
    event: 'app_boot',
    surface: 'web',
    install_token: 'a'.repeat(32) as TelemetryEvent['install_token'],
    session_token: 'b'.repeat(16) as TelemetryEvent['session_token'],
    client_day: 20000,
    app_version_major: 0,
    app_version_minor: 0,
    app_version_patch: 0,
    engine_family: 'duckdb_wasm',
    os_family: 'linux',
    build_channel: 'dev',
  }
}

function response(ok: boolean, status: number): Response {
  return { ok, status } as Response
}

/** Let an already-queued microtask/timer tail settle (never a real wait). */
async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

interface CountingSignal {
  /** Structurally an `AbortSignal`: the transport only reads `aborted` and
   * subscribes to `abort` (the cast keeps that seam explicit). */
  readonly signal: AbortSignal
  /** Abort listeners currently attached — the §3.3 cleanup assertion. */
  readonly listeners: number
  abort(): void
}

/**
 * A real abort signal with listener bookkeeping, injected as the caller seam so
 * the suite can assert that no listener is left on the runtime's generation
 * signal after a send settles (E01 §4 item 7).
 */
function countingSignal(): CountingSignal {
  const controller = new AbortController()
  const { signal: real } = controller
  let listeners = 0
  const signal = {
    get aborted(): boolean {
      return real.aborted
    },
    addEventListener: (
      type: string,
      listener: () => void,
      options?: AddEventListenerOptions,
    ): void => {
      if (type === 'abort') listeners += 1
      real.addEventListener(type, listener, options)
    },
    removeEventListener: (type: string, listener: () => void): void => {
      if (type === 'abort') listeners -= 1
      real.removeEventListener(type, listener)
    },
  } as unknown as AbortSignal
  return {
    signal,
    get listeners(): number {
      return listeners
    },
    abort: (): void => {
      controller.abort()
    },
  }
}

/**
 * `fetch` that only settles when its attempt signal aborts — the in-flight
 * window an opt-out must be able to close (E01 §3.3).
 */
function hangingFetch(): { readonly fetchImpl: typeof fetch; readonly calls: () => number } {
  let calls = 0
  const fetchImpl = ((_url: string, init: RequestInit) => {
    calls += 1
    return new Promise<Response>((_resolve, reject) => {
      const signal = init.signal
      const fail = (): void => {
        reject(new Error('aborted'))
      }
      if (signal?.aborted === true) {
        fail()
        return
      }
      signal?.addEventListener('abort', fail, { once: true })
    })
  }) as unknown as typeof fetch
  return { fetchImpl, calls: () => calls }
}

describe('createFetchTransport — §8.3/Appendix B failure policy', () => {
  it('accepts a 2xx with one call', async () => {
    const fetchImpl = vi.fn(async () => response(true, 200))
    const transport = createFetchTransport({
      endpoint: 'https://collector.example',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => undefined,
    })
    await transport.send([event()])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('drops a 4xx without retrying', async () => {
    const fetchImpl = vi.fn(async () => response(false, 400))
    const transport = createFetchTransport({
      endpoint: 'https://collector.example',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => undefined,
    })
    await transport.send([event()])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('retries a 5xx at most twice, then drops', async () => {
    const fetchImpl = vi.fn(async () => response(false, 500))
    const sleep = vi.fn(async () => undefined)
    const transport = createFetchTransport({
      endpoint: 'https://collector.example',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retries: 2,
      sleep,
    })
    await transport.send([event()])
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('retries a network failure and then drops (never throws)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('offline')
    })
    const transport = createFetchTransport({
      endpoint: 'https://collector.example',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retries: 2,
      sleep: async () => undefined,
    })
    await expect(transport.send([event()])).resolves.toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('sends the optional ingest token as an Authorization header', async () => {
    let captured: RequestInit | undefined
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      captured = init
      return response(true, 200)
    })
    const transport = createFetchTransport({
      endpoint: 'https://collector.example',
      token: 'secret-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => undefined,
    })
    await transport.send([event()])
    expect((captured?.headers as Record<string, string>)['authorization']).toBe(
      'Bearer secret-token',
    )
  })

  it('does nothing for an empty batch', async () => {
    const fetchImpl = vi.fn(async () => response(true, 200))
    const transport = createFetchTransport({
      endpoint: 'https://collector.example',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => undefined,
    })
    await transport.send([])
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('createFetchTransport — E01 caller cancellation (§3.1/§3.3)', () => {
  it('starts nothing when the caller signal is already aborted', async () => {
    const caller = countingSignal()
    caller.abort()
    const fetchImpl = vi.fn(async () => response(true, 200))
    const transport = createFetchTransport({
      endpoint: 'https://collector.example',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => undefined,
    })
    await expect(transport.send([event()], { signal: caller.signal })).resolves.toBeUndefined()
    expect(fetchImpl).not.toHaveBeenCalled()
    expect(caller.listeners).toBe(0)
  })

  it('keeps working for a transport call that passes no options at all', async () => {
    const fetchImpl = vi.fn(async () => response(false, 500))
    const transport = createFetchTransport({
      endpoint: 'https://collector.example',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retries: 1,
      sleep: async () => undefined,
    })
    await expect(transport.send([event()])).resolves.toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('aborts the in-flight attempt, drops the batch and never retries', async () => {
    const caller = countingSignal()
    const { fetchImpl, calls } = hangingFetch()
    const sleep = vi.fn(async () => undefined)
    const transport = createFetchTransport({
      endpoint: 'https://collector.example',
      fetchImpl,
      retries: 2,
      sleep,
    })
    const sending = transport.send([event()], { signal: caller.signal })
    await tick()
    expect(calls()).toBe(1)
    caller.abort()
    await expect(sending).resolves.toBeUndefined()
    // Dropped: no second attempt, no backoff.
    expect(calls()).toBe(1)
    expect(sleep).not.toHaveBeenCalled()
    expect(caller.listeners).toBe(0)
  })

  it('settles the backoff early and starts no further fetch after a caller abort', async () => {
    const caller = countingSignal()
    let attempts = 0
    // A second attempt would succeed immediately, so a spurious retry after the
    // abort shows up as a counted attempt instead of a hung promise.
    const fetchImpl = vi.fn(async () => {
      attempts += 1
      return attempts === 1 ? response(false, 500) : response(true, 200)
    })
    // A backoff seam that never finishes on its own: only the abort can end it
    // (and it cleans up its own listener, like `defaultSleep` does).
    const sleep = vi.fn((_ms: number, signal?: AbortSignal) => {
      return new Promise<void>((resolve) => {
        const done = (): void => {
          signal?.removeEventListener('abort', done)
          resolve()
        }
        signal?.addEventListener('abort', done, { once: true })
      })
    })
    const transport = createFetchTransport({
      endpoint: 'https://collector.example',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retries: 2,
      sleep,
    })
    const sending = transport.send([event()], { signal: caller.signal })
    await tick()
    expect(attempts).toBe(1)
    expect(sleep).toHaveBeenCalledTimes(1)
    caller.abort()
    await expect(sending).resolves.toBeUndefined()
    // The batch was dropped during the backoff: no next fetch, no caller
    // listener left behind.
    expect(attempts).toBe(1)
    expect(caller.listeners).toBe(0)
  })

  it('keeps the per-attempt timeout retryable, distinct from a caller abort', async () => {
    vi.useFakeTimers()
    try {
      const { fetchImpl, calls } = hangingFetch()
      const transport = createFetchTransport({
        endpoint: 'https://collector.example',
        fetchImpl,
        timeoutMs: 1,
        retries: 1,
        sleep: () => Promise.resolve(),
      })
      const sending = transport.send([event()])
      await vi.advanceTimersByTimeAsync(10)
      await vi.advanceTimersByTimeAsync(10)
      await expect(sending).resolves.toBeUndefined()
      // A timeout is still a retryable attempt failure (no caller involved).
      expect(calls()).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('leaves no attempt timer and no caller-signal listener after settle', async () => {
    vi.useFakeTimers()
    try {
      const caller = countingSignal()
      const fetchImpl = vi.fn(async () => response(true, 200))
      const transport = createFetchTransport({
        endpoint: 'https://collector.example',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleep: async () => undefined,
      })
      // Repeated sends on ONE generation signal must not accumulate listeners.
      await transport.send([event()], { signal: caller.signal })
      await transport.send([event()], { signal: caller.signal })
      expect(fetchImpl).toHaveBeenCalledTimes(2)
      expect(caller.listeners).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
