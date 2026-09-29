// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from 'vitest'
import type { TelemetryEvent } from '@assay/telemetry'
import { createCliTransport } from './transport'

function event(): TelemetryEvent {
  return {
    schema_version: 1,
    event: 'app_boot',
    surface: 'cli',
    install_token: 'a'.repeat(32) as TelemetryEvent['install_token'],
    session_token: 'b'.repeat(16) as TelemetryEvent['session_token'],
    client_day: 20000,
    app_version_major: 0,
    app_version_minor: 0,
    app_version_patch: 0,
    engine_family: 'duckdb_node',
    os_family: 'linux',
    build_channel: 'release',
  }
}

function response(ok: boolean, status: number): Response {
  return { ok, status } as Response
}

describe('createCliTransport — §8.3/Appendix B failure policy', () => {
  it('accepts 2xx, drops 4xx without retry, retries 5xx twice', async () => {
    const ok = vi.fn(async () => response(true, 200))
    await createCliTransport({
      endpoint: 'https://x',
      fetchImpl: ok as unknown as typeof fetch,
      sleep: async () => undefined,
    }).send([event()])
    expect(ok).toHaveBeenCalledTimes(1)

    const bad = vi.fn(async () => response(false, 422))
    await createCliTransport({
      endpoint: 'https://x',
      fetchImpl: bad as unknown as typeof fetch,
      sleep: async () => undefined,
    }).send([event()])
    expect(bad).toHaveBeenCalledTimes(1)

    const down = vi.fn(async () => response(false, 503))
    const sleep = vi.fn(async () => undefined)
    await createCliTransport({
      endpoint: 'https://x',
      fetchImpl: down as unknown as typeof fetch,
      retries: 2,
      sleep,
    }).send([event()])
    expect(down).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('never throws on a network failure or empty batch', async () => {
    const offline = vi.fn(async () => {
      throw new Error('offline')
    })
    await expect(
      createCliTransport({
        endpoint: 'https://x',
        fetchImpl: offline as unknown as typeof fetch,
        sleep: async () => undefined,
      }).send([event()]),
    ).resolves.toBeUndefined()
    const ok = vi.fn(async () => response(true, 200))
    await createCliTransport({
      endpoint: 'https://x',
      fetchImpl: ok as unknown as typeof fetch,
      sleep: async () => undefined,
    }).send([])
    expect(ok).not.toHaveBeenCalled()
  })
})
