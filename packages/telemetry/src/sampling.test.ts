// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_RATES_PER_MILLE,
  MAX_RATE_PER_MILLE,
  bucketOfDigest,
  createSampler,
  platformHmacSha256,
  resolveRates,
  type HmacSha256,
  type InstallToken,
  type SamplingContext,
  type SessionToken,
} from './index.js'
import { digestForValue } from './test-support.js'

const INSTALL = '00112233445566778899aabbccddeeff' as InstallToken
const SESSION = 'a1b2c3d4e5f60718' as SessionToken

function toHex(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex
}

function context(overrides: Partial<SamplingContext> = {}): SamplingContext {
  return {
    event: 'query_run',
    localSeq: 7,
    installToken: () => INSTALL,
    sessionToken: () => SESSION,
    ...overrides,
  }
}

/** An HMAC that always returns a digest whose per-mille bucket is `bucket`. */
function hmacForBucket(bucket: number): HmacSha256 {
  return async () => digestForValue(bucket)
}

describe('sampling — compiled-in rates and overrides (design §5.3)', () => {
  it('pins the §5 per-mille defaults', () => {
    expect(DEFAULT_RATES_PER_MILLE).toEqual({
      app_boot: 1000,
      disclosure_shown: 1000,
      dataset_opened: 1000,
      dataset_open_failed: 1000,
      validation_run: 1000,
      diff_run: 1000,
      export_run: 1000,
      profile_run: 250,
      query_run: 100,
    })
  })

  it('clamps, truncates, and defaults injected overrides', () => {
    const rates = resolveRates({
      query_run: 5000,
      profile_run: -10,
      diff_run: 12.9,
      app_boot: Number.NaN,
    })
    expect(rates.query_run).toBe(MAX_RATE_PER_MILLE)
    expect(rates.profile_run).toBe(0)
    expect(rates.diff_run).toBe(12)
    expect(rates.app_boot).toBe(1000)
    expect(resolveRates()).toEqual(DEFAULT_RATES_PER_MILLE)
  })
})

describe('sampling — §5.1 predicate', () => {
  it('rate 1000 is always in, with no HMAC or token work', async () => {
    const hmac = vi.fn(hmacForBucket(999))
    const installToken = vi.fn(() => INSTALL)
    const sessionToken = vi.fn(() => SESSION)
    const sampler = createSampler({ hmac, rates: { app_boot: 1000 } })
    await expect(sampler(context({ event: 'app_boot', installToken, sessionToken }))).resolves.toBe(
      true,
    )
    expect(hmac).not.toHaveBeenCalled()
    expect(installToken).not.toHaveBeenCalled()
    expect(sessionToken).not.toHaveBeenCalled()
  })

  it('rate 0 is always out, with no HMAC work (except bypasses)', async () => {
    const hmac = vi.fn(hmacForBucket(0))
    const sampler = createSampler({ hmac, rates: { query_run: 0 } })
    await expect(sampler(context())).resolves.toBe(false)
    expect(hmac).not.toHaveBeenCalled()
  })

  it('bypasses on first-of-session without touching tokens or HMAC', async () => {
    const hmac = vi.fn(hmacForBucket(999))
    const installToken = vi.fn(() => INSTALL)
    const sampler = createSampler({ hmac, rates: { query_run: 0 } })
    await expect(sampler(context({ firstOfSession: true, installToken }))).resolves.toBe(true)
    expect(hmac).not.toHaveBeenCalled()
    expect(installToken).not.toHaveBeenCalled()
  })

  it('bypasses on error/cancelled/aborted outcomes, but not success', async () => {
    const sampler = createSampler({ hmac: hmacForBucket(999), rates: { query_run: 0 } })
    await expect(sampler(context({ outcome: 'error' }))).resolves.toBe(true)
    await expect(sampler(context({ outcome: 'cancelled' }))).resolves.toBe(true)
    await expect(sampler(context({ outcome: 'aborted' }))).resolves.toBe(true)
    await expect(sampler(context({ outcome: 'success' }))).resolves.toBe(false)
  })

  it('boundary semantics are bucket < rate', async () => {
    const at = (bucket: number, rate: number) =>
      createSampler({ hmac: hmacForBucket(bucket), rates: { query_run: rate } })(context())
    await expect(at(0, 1)).resolves.toBe(true)
    await expect(at(1, 1)).resolves.toBe(false)
    await expect(at(998, 999)).resolves.toBe(true)
    await expect(at(999, 999)).resolves.toBe(false)
    await expect(at(499, 500)).resolves.toBe(true)
    await expect(at(500, 500)).resolves.toBe(false)
  })

  it('hashes the documented key/message bytes', async () => {
    let seen: { key: string; message: string } | null = null
    const hmac: HmacSha256 = async (key, message) => {
      seen = { key: new TextDecoder().decode(key), message: new TextDecoder().decode(message) }
      return digestForValue(0)
    }
    const sampler = createSampler({ hmac, rates: { query_run: 1 } })
    await sampler(context({ localSeq: 42 }))
    expect(seen).toEqual({ key: INSTALL, message: `${SESSION}query_run42` })
  })

  it('is deterministic across repeated calls (platform HMAC)', async () => {
    const sampler = createSampler({ rates: { query_run: 500 } })
    const first = await sampler(context())
    const second = await sampler(context())
    const third = await sampler(context())
    expect(second).toBe(first)
    expect(third).toBe(first)
  })

  it('pins the platform HMAC-SHA256 output vector', async () => {
    const digest = await platformHmacSha256(
      new TextEncoder().encode(INSTALL),
      new TextEncoder().encode(`${SESSION}query_run7`),
    )
    expect(toHex(digest)).toBe('9617df565ea7aead2ceb9b8ce178ce93cd8c1a5b5fd8eed446a32c15aa406dcc')
    expect(bucketOfDigest(digest)).toBe(780)
  })
})
