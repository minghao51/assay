// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit suite for the Netlify collector function (operator contract
 * `docs/engineering/07-telemetry-collector.md` §2, §2.1, §2.2).
 *
 * Each case is written so that deleting the behaviour it names fails it: the
 * refusal cases assert the status *and* the reason the handler returned, so a
 * handler that accepted everything would fail rather than pass.
 *
 * Events are built from `@assay/telemetry`'s own descriptor
 * (`ENVELOPE_SCHEMA` / `EVENT_SCHEMAS`), never from a hand-written field list —
 * the collector and its tests share one schema, so a schema change cannot leave
 * a stale copy here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ENVELOPE_SCHEMA,
  EVENTS,
  EVENT_SCHEMAS,
  type EventName,
  type FieldSpec,
  type ValidationErrorCode,
} from '@assay/telemetry'
import handler, {
  ALLOWED_ORIGINS_ENV,
  MAX_EVENTS_PER_REQUEST,
  MAX_REQUEST_BYTES,
  type CollectorRefusal,
} from './collect.js'

const ENDPOINT = 'https://collector.example.invalid/.netlify/functions/collect'

/** A representative valid value for a descriptor field (nothing value-bearing). */
function sampleValue(field: string, spec: FieldSpec): unknown {
  switch (spec.kind) {
    case 'enum':
      return spec.values[0]
    case 'boolean':
      return true
    case 'bounded-int':
      return field === 'schema_version' ? 1 : spec.min
    case 'token':
      return 'a'.repeat(spec.length)
  }
}

/** A valid event for `event`, built from the package descriptor. */
function validEvent(event: EventName = 'app_boot'): Record<string, unknown> {
  const built: Record<string, unknown> = {}
  for (const [field, spec] of Object.entries(ENVELOPE_SCHEMA)) {
    built[field] = sampleValue(field, spec)
  }
  for (const [field, spec] of Object.entries(EVENT_SCHEMAS[event].fields)) {
    built[field] = sampleValue(field, spec)
  }
  built['event'] = event
  return built
}

function postRequest(body: string, headers: Readonly<Record<string, string>> = {}): Request {
  return new Request(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  })
}

/** Assert a refusal and return the response text (for privacy assertions). */
async function expectRefusal(
  response: Response,
  status: number,
  reason: CollectorRefusal,
  detail?: ValidationErrorCode,
): Promise<string> {
  const text = await response.text()
  expect(response.status, text).toBe(status)
  const body = JSON.parse(text) as { ok?: boolean; reason?: string; detail?: string }
  expect(body.ok).toBe(false)
  expect(body.reason).toBe(reason)
  if (detail !== undefined) expect(body.detail).toBe(detail)
  return text
}

/** Capture every console call the handler makes. */
function captureConsole(): { text: () => string; calls: () => unknown[][] } {
  const spies = [
    vi.spyOn(console, 'log').mockImplementation(() => {}),
    vi.spyOn(console, 'info').mockImplementation(() => {}),
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
    vi.spyOn(console, 'error').mockImplementation(() => {}),
    vi.spyOn(console, 'debug').mockImplementation(() => {}),
  ]
  const calls = (): unknown[][] => spies.flatMap((spy) => spy.mock.calls as unknown[][])
  return { calls, text: () => JSON.stringify(calls()) }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('collector — accepted batches', () => {
  it('accepts a batch with one valid event and echoes nothing back', async () => {
    const response = await handler(postRequest(JSON.stringify([validEvent()])))
    expect(response.status).toBe(202)
    expect(await response.text()).toBe('{"ok":true}')
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('accepts every active event name in the closed allowlist', async () => {
    for (const event of EVENTS) {
      const response = await handler(postRequest(JSON.stringify([validEvent(event)])))
      expect(response.status, event).toBe(202)
    }
  })

  it('accepts a batch at the batch cap (upper boundary is inclusive)', async () => {
    const batch = Array.from({ length: MAX_EVENTS_PER_REQUEST }, () => validEvent())
    expect(MAX_EVENTS_PER_REQUEST).toBe(32)
    const response = await handler(postRequest(JSON.stringify(batch)))
    expect(response.status).toBe(202)
  })

  it('accepts a body just under the byte cap', async () => {
    // Pad with spaces outside any string: still valid JSON, still under the cap.
    const payload = JSON.stringify([validEvent()])
    const padded = `${payload}${' '.repeat(MAX_REQUEST_BYTES - payload.length - 1)}`
    expect(padded.length).toBeLessThanOrEqual(MAX_REQUEST_BYTES)
    expect((await handler(postRequest(padded))).status).toBe(202)
  })
})

describe('collector — body and batch bounds', () => {
  it('refuses an empty array (lower batch boundary)', async () => {
    await expectRefusal(await handler(postRequest('[]')), 400, 'empty-batch')
  })

  it('refuses an array one event over the batch cap (upper boundary)', async () => {
    const batch = Array.from({ length: MAX_EVENTS_PER_REQUEST + 1 }, () => validEvent())
    await expectRefusal(await handler(postRequest(JSON.stringify(batch))), 400, 'batch-too-large')
  })

  it('refuses a body over the byte cap with 413 rather than crashing', async () => {
    const oversized = `[${'x'.repeat(MAX_REQUEST_BYTES)}]`
    const response = await handler(postRequest(oversized))
    await expectRefusal(response, 413, 'body-too-large')
  })

  it('refuses early on a declared content-length over the cap (before reading the body)', async () => {
    const reader = { called: false }
    const stub = {
      method: 'POST',
      headers: new Headers({
        'content-type': 'application/json',
        'content-length': String(MAX_REQUEST_BYTES + 1),
      }),
      arrayBuffer: () => {
        reader.called = true
        return Promise.resolve(new ArrayBuffer(2))
      },
    } as unknown as Request
    await expectRefusal(await handler(stub), 413, 'body-too-large')
    expect(reader.called).toBe(false)
  })
})

describe('collector — strict allowlist validation (reuses @assay/telemetry)', () => {
  it('refuses an unknown field instead of dropping or storing it', async () => {
    const response = await handler(
      postRequest(JSON.stringify([{ ...validEvent(), filename: 'customers-2026.parquet' }])),
    )
    await expectRefusal(response, 400, 'invalid-event', 'unknown-field')
  })

  it('refuses the reserved pipeline_run event as unknown for schema v1', async () => {
    const event = { ...validEvent(), event: 'pipeline_run' }
    await expectRefusal(
      await handler(postRequest(JSON.stringify([event]))),
      400,
      'invalid-event',
      'unknown-event',
    )
  })

  it('refuses an event name outside the allowlist', async () => {
    const event = { ...validEvent(), event: 'dataset_saved' }
    await expectRefusal(
      await handler(postRequest(JSON.stringify([event]))),
      400,
      'invalid-event',
      'unknown-event',
    )
  })

  it('refuses a wrong type rather than coercing it', async () => {
    const event = { ...validEvent(), surface: 7 }
    await expectRefusal(
      await handler(postRequest(JSON.stringify([event]))),
      400,
      'invalid-event',
      'wrong-type',
    )
  })

  it('refuses a value outside a closed enum', async () => {
    const event = { ...validEvent(), surface: 'mobile' }
    await expectRefusal(
      await handler(postRequest(JSON.stringify([event]))),
      400,
      'invalid-event',
      'invalid-enum',
    )
  })

  it('refuses a token that is not the fixed grammar', async () => {
    const event = { ...validEvent(), install_token: 'not-a-token' }
    await expectRefusal(
      await handler(postRequest(JSON.stringify([event]))),
      400,
      'invalid-event',
      'invalid-token',
    )
  })

  it('refuses an out-of-range bounded integer', async () => {
    const event = { ...validEvent('diff_run'), aspects_count: 5 }
    await expectRefusal(
      await handler(postRequest(JSON.stringify([event]))),
      400,
      'invalid-event',
      'out-of-range',
    )
  })

  it('refuses a missing envelope field', async () => {
    const event = validEvent()
    delete event['session_token']
    await expectRefusal(
      await handler(postRequest(JSON.stringify([event]))),
      400,
      'invalid-event',
      'missing-field',
    )
  })

  it('refuses a non-object element', async () => {
    await expectRefusal(
      await handler(postRequest(JSON.stringify(['app_boot']))),
      400,
      'invalid-event',
      'not-an-object',
    )
  })

  it('refuses the whole batch when one element is invalid (strict mode)', async () => {
    const batch = [validEvent(), validEvent('export_run'), { ...validEvent(), extra: 1 }]
    await expectRefusal(
      await handler(postRequest(JSON.stringify(batch))),
      400,
      'invalid-event',
      'unknown-field',
    )
  })

  it('refuses malformed JSON', async () => {
    await expectRefusal(await handler(postRequest('{"not":"an array"')), 400, 'malformed-json')
  })

  it('refuses a JSON object instead of an array', async () => {
    await expectRefusal(
      await handler(postRequest(JSON.stringify(validEvent()))),
      400,
      'not-an-array',
    )
  })

  it('refuses a non-JSON content type', async () => {
    const response = await handler(
      postRequest(JSON.stringify([validEvent()]), { 'content-type': 'text/plain' }),
    )
    await expectRefusal(response, 415, 'unsupported-media-type')
  })

  it('refuses a missing content type', async () => {
    const request = new Request(ENDPOINT, {
      method: 'POST',
      body: JSON.stringify([validEvent()]),
    })
    expect(request.headers.get('content-type')).toBe('text/plain;charset=UTF-8')
    await expectRefusal(await handler(request), 415, 'unsupported-media-type')
  })
})

describe('collector — method handling', () => {
  it('refuses GET with 405, an Allow header and no body echo', async () => {
    const request = new Request(ENDPOINT, { method: 'GET' })
    const response = await handler(request)
    await expectRefusal(response, 405, 'method-not-allowed')
    expect(response.headers.get('allow')).toBe('POST, OPTIONS')
  })

  it('refuses PUT and DELETE', async () => {
    for (const method of ['PUT', 'DELETE']) {
      const response = await handler(
        new Request(ENDPOINT, { method, body: method === 'DELETE' ? undefined : '[]' }),
      )
      await expectRefusal(response, 405, 'method-not-allowed')
    }
  })

  it('answers OPTIONS with 204 and the POST/OPTIONS methods for an allowed origin', async () => {
    vi.stubEnv(ALLOWED_ORIGINS_ENV, 'https://app.example.org')
    const response = await handler(
      new Request(ENDPOINT, { method: 'OPTIONS', headers: { origin: 'https://app.example.org' } }),
    )
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS')
    expect(response.headers.get('access-control-allow-headers')).toBe('content-type, authorization')
    expect(response.headers.get('access-control-allow-origin')).toBe('https://app.example.org')
  })

  it('answers OPTIONS without granting an origin when none is configured (same-origin default)', async () => {
    const response = await handler(
      new Request(ENDPOINT, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }),
    )
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
    expect(response.headers.get('access-control-allow-methods')).toBeNull()
  })

  it('never sends a wildcard origin, even for an allowed caller', async () => {
    vi.stubEnv(ALLOWED_ORIGINS_ENV, 'https://app.example.org, https://staging.example.org')
    const response = await handler(
      postRequest(JSON.stringify([validEvent()]), { origin: 'https://staging.example.org' }),
    )
    expect(response.status).toBe(202)
    expect(response.headers.get('access-control-allow-origin')).toBe('https://staging.example.org')
    expect(response.headers.get('access-control-allow-origin')).not.toBe('*')
  })

  it('sends no origin grant to a caller outside the allowlist', async () => {
    vi.stubEnv(ALLOWED_ORIGINS_ENV, 'https://app.example.org')
    const response = await handler(
      postRequest(JSON.stringify([validEvent()]), { origin: 'https://evil.example' }),
    )
    expect(response.status).toBe(202)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('collector — total handler', () => {
  it('turns a rejecting body read into a value-free 500 and never throws', async () => {
    const stub = {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      arrayBuffer: () => Promise.reject(new Error('sentinel-body-read-failure')),
    } as unknown as Request
    const text = await expectRefusal(await handler(stub), 500, 'unexpected-error')
    expect(text).not.toContain('sentinel-body-read-failure')
  })

  it('turns unreadable headers into a value-free failure instead of a throw', async () => {
    const stub = {
      get method() {
        throw new Error('sentinel-method-trap')
      },
      get headers() {
        throw new Error('sentinel-header-trap')
      },
    } as unknown as Request
    const response = await handler(stub)
    expect(response.status).toBe(500)
    expect(await response.text()).not.toContain('sentinel')
  })
})

describe('collector — privacy (ADR 0025)', () => {
  const CANARIES = [
    '/home/analyst/secret/patient_records_2026.parquet',
    'john.doe@example.com',
    "SELECT card FROM customers WHERE ssn = '123-45-6789'",
    '<script>alert(1)</script>',
  ]
  let consoleCapture: ReturnType<typeof captureConsole>

  beforeEach(() => {
    consoleCapture = captureConsole()
  })

  it('leaks no submitted value into the refusal response or the console', async () => {
    const hostile = {
      ...validEvent(),
      filename: CANARIES[0],
      contact: CANARIES[1],
      sql: CANARIES[2],
      html: CANARIES[3],
      cell_value: CANARIES[1],
    }
    const raw = JSON.stringify([hostile])
    const responseText = await expectRefusal(
      await handler(postRequest(raw)),
      400,
      'invalid-event',
      'unknown-field',
    )
    const logged = consoleCapture.text()
    for (const canary of CANARIES) {
      expect(responseText, canary).not.toContain(canary)
      expect(logged, canary).not.toContain(canary)
    }
    // The submitted install/session tokens are allowlisted fields, but they are
    // still values: neither the response nor the log may echo them.
    expect(responseText).not.toContain('a'.repeat(32))
    expect(logged).not.toContain('a'.repeat(32))
    // Nor may any part of the raw body survive into the log.
    expect(logged).not.toContain(raw.slice(0, 40))
  })

  it('logs a refusal as a fixed prefix plus closed codes only', async () => {
    const warn = vi.mocked(console.warn)
    await handler(postRequest(JSON.stringify([{ ...validEvent(), filename: 'x.parquet' }])))
    expect(warn.mock.calls).toEqual([
      ['[telemetry-collector] refused:', 'invalid-event', 'unknown-field'],
    ])
  })

  it('logs an internal failure as a fixed prefix plus one closed code', async () => {
    const error = vi.mocked(console.error)
    const stub = {
      method: 'POST',
      headers: new Headers({ 'content-type': 'application/json' }),
      arrayBuffer: () => Promise.reject(new Error('sentinel')),
    } as unknown as Request
    await handler(stub)
    expect(error.mock.calls).toEqual([['[telemetry-collector] refused:', 'unexpected-error']])
  })

  it('logs nothing at all for an accepted batch', async () => {
    await handler(postRequest(JSON.stringify([validEvent()])))
    expect(consoleCapture.calls()).toEqual([])
  })
})
