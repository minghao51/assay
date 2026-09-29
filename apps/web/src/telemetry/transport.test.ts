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
