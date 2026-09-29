// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from 'vitest'
import {
  createTelemetryCore,
  type HmacSha256,
  type InstallToken,
  type SessionToken,
} from './index.js'
import { digestForValue } from './test-support.js'

const INSTALL = '00112233445566778899aabbccddeeff' as InstallToken
const SESSION = 'a1b2c3d4e5f60718' as SessionToken

describe('createTelemetryCore — endpoint gate + sampling (design §5/§8)', () => {
  it('is disabled with no/invalid endpoint and does zero token/HMAC work', async () => {
    const hmac = vi.fn<HmacSha256>(async () => digestForValue(0))
    const installToken = vi.fn(() => INSTALL)
    const sessionToken = vi.fn(() => SESSION)
    for (const endpoint of [undefined, '', 'http://example.com', 'not a url', 'ftp://x']) {
      const core = createTelemetryCore({ endpoint, installToken, sessionToken, hmac })
      expect(core.enabled, String(endpoint)).toBe(false)
      await expect(core.shouldEmit('app_boot', { localSeq: 1 })).resolves.toBe(false)
    }
    expect(hmac).not.toHaveBeenCalled()
    expect(installToken).not.toHaveBeenCalled()
    expect(sessionToken).not.toHaveBeenCalled()
  })

  it('is enabled with a valid endpoint', () => {
    expect(
      createTelemetryCore({
        endpoint: 'https://collector.example',
        installToken: INSTALL,
        sessionToken: SESSION,
      }).enabled,
    ).toBe(true)
    expect(
      createTelemetryCore({
        endpoint: 'http://localhost:8080',
        installToken: INSTALL,
        sessionToken: SESSION,
      }).enabled,
    ).toBe(true)
  })

  it('honors rate overrides for the sampling decision', async () => {
    const always = createTelemetryCore({
      endpoint: 'https://collector.example',
      installToken: INSTALL,
      sessionToken: SESSION,
      hmac: async () => digestForValue(999),
      rates: { query_run: 1000 },
    })
    await expect(always.shouldEmit('query_run', { localSeq: 1 })).resolves.toBe(true)

    const never = createTelemetryCore({
      endpoint: 'https://collector.example',
      installToken: INSTALL,
      sessionToken: SESSION,
      hmac: async () => digestForValue(0),
      rates: { query_run: 0 },
    })
    await expect(never.shouldEmit('query_run', { localSeq: 1 })).resolves.toBe(false)
    await expect(never.shouldEmit('query_run', { localSeq: 1, outcome: 'error' })).resolves.toBe(
      true,
    )
  })

  it('accepts lazy token providers and resolves them per decision', async () => {
    let installCalls = 0
    const core = createTelemetryCore({
      endpoint: 'https://collector.example',
      installToken: () => {
        installCalls += 1
        return INSTALL
      },
      sessionToken: () => SESSION,
      hmac: async () => digestForValue(0),
      rates: { query_run: 1, app_boot: 1000 },
    })
    await expect(core.shouldEmit('app_boot', { localSeq: 1 })).resolves.toBe(true)
    expect(installCalls).toBe(0)
    await expect(core.shouldEmit('query_run', { localSeq: 2 })).resolves.toBe(true)
    expect(installCalls).toBe(1)
  })

  it('takes no payload, so no event can be constructed inside the decision', () => {
    const core = createTelemetryCore({
      endpoint: 'https://collector.example',
      installToken: INSTALL,
      sessionToken: SESSION,
    })
    expect(Object.keys(core).sort()).toEqual(['enabled', 'shouldEmit'])
    expect(core.shouldEmit.length).toBe(2)
  })
})
