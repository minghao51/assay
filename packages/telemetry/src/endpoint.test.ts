// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { isTelemetryEnabled, validateEndpoint } from './index.js'

describe('validateEndpoint — inert-by-default endpoint gate (design §8.2)', () => {
  it('treats unset/blank/non-string endpoints as missing (disabled)', () => {
    expect(validateEndpoint(undefined)).toEqual({ ok: false, reason: 'missing' })
    expect(validateEndpoint(null)).toEqual({ ok: false, reason: 'missing' })
    expect(validateEndpoint('')).toEqual({ ok: false, reason: 'missing' })
    expect(validateEndpoint('   ')).toEqual({ ok: false, reason: 'missing' })
    expect(validateEndpoint(42)).toEqual({ ok: false, reason: 'missing' })
  })

  it('rejects malformed URLs', () => {
    expect(validateEndpoint('not a url')).toEqual({ ok: false, reason: 'malformed' })
    expect(validateEndpoint('://x')).toEqual({ ok: false, reason: 'malformed' })
    expect(validateEndpoint('https://')).toEqual({ ok: false, reason: 'malformed' })
  })

  it('rejects non-http(s) schemes', () => {
    expect(validateEndpoint('ftp://example.com')).toEqual({
      ok: false,
      reason: 'unsupported-scheme',
    })
    expect(validateEndpoint('file:///etc/passwd')).toEqual({
      ok: false,
      reason: 'unsupported-scheme',
    })
    expect(validateEndpoint('javascript:alert(1)')).toEqual({
      ok: false,
      reason: 'unsupported-scheme',
    })
  })

  it('permits https anywhere', () => {
    const result = validateEndpoint('https://collector.example/ingest')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.href).toBe('https://collector.example/ingest')
    expect(validateEndpoint('HTTPS://Example.COM').ok).toBe(true)
  })

  it('permits http only for loopback hosts', () => {
    expect(validateEndpoint('http://localhost:8080').ok).toBe(true)
    expect(validateEndpoint('http://127.0.0.1:9000').ok).toBe(true)
    expect(validateEndpoint('http://[::1]:9000').ok).toBe(true)
  })

  it('rejects cleartext non-loopback hosts', () => {
    expect(validateEndpoint('http://example.com')).toEqual({
      ok: false,
      reason: 'insecure-cleartext',
    })
    expect(validateEndpoint('http://0.0.0.0:8080')).toEqual({
      ok: false,
      reason: 'insecure-cleartext',
    })
    expect(validateEndpoint('http://sub.localhost')).toEqual({
      ok: false,
      reason: 'insecure-cleartext',
    })
    expect(validateEndpoint('http://127.0.0.2')).toEqual({
      ok: false,
      reason: 'insecure-cleartext',
    })
  })

  it('rejects credentials embedded in the URL', () => {
    expect(validateEndpoint('https://user:pass@collector.example')).toEqual({
      ok: false,
      reason: 'credentials',
    })
    expect(validateEndpoint('https://user@collector.example')).toEqual({
      ok: false,
      reason: 'credentials',
    })
    expect(validateEndpoint('http://token@localhost:8080')).toEqual({
      ok: false,
      reason: 'credentials',
    })
  })

  it('isTelemetryEnabled mirrors validation', () => {
    expect(isTelemetryEnabled('https://collector.example')).toBe(true)
    expect(isTelemetryEnabled('http://localhost:8080')).toBe(true)
    expect(isTelemetryEnabled('http://example.com')).toBe(false)
    expect(isTelemetryEnabled(undefined)).toBe(false)
    expect(isTelemetryEnabled('')).toBe(false)
  })
})
