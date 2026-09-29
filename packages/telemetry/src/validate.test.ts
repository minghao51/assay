// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { EVENTS, EVENT_SCHEMAS, SURFACES, validateEvent, type TelemetryEvent } from './index.js'
import { CANARY_CORPUS, validEventFor } from './test-support.js'

describe('validateEvent — happy path and enum coverage (design §3)', () => {
  it('accepts a valid event for all nine active events', () => {
    for (const event of EVENTS) {
      const result = validateEvent(validEventFor(event))
      expect(result.ok, event).toBe(true)
      if (result.ok) expect(result.value.event).toBe(event)
    }
  })

  it('accepts every declared enum member for every payload enum field', () => {
    for (const event of EVENTS) {
      for (const [field, spec] of Object.entries(EVENT_SCHEMAS[event].fields)) {
        if (spec.kind !== 'enum') continue
        for (const value of spec.values) {
          const result = validateEvent(validEventFor(event, { [field]: value }))
          expect(result.ok, `${event}.${field}=${value}`).toBe(true)
        }
      }
    }
  })

  it('accepts every surface enum member', () => {
    for (const surface of SURFACES) {
      expect(validateEvent(validEventFor('app_boot', { surface })).ok, surface).toBe(true)
    }
  })

  it('clamps checks_run above the bound and below zero (design §3.6)', () => {
    const high = validateEvent(validEventFor('validation_run', { checks_run: 99_999 }))
    expect(high.ok).toBe(true)
    if (high.ok && high.value.event === 'validation_run') expect(high.value.checks_run).toBe(10_000)
    const low = validateEvent(validEventFor('validation_run', { checks_run: -5 }))
    expect(low.ok).toBe(true)
    if (low.ok && low.value.event === 'validation_run') expect(low.value.checks_run).toBe(0)
    const inRange = validateEvent(validEventFor('validation_run', { checks_run: 9999 }))
    expect(inRange.ok).toBe(true)
    if (inRange.ok && inRange.value.event === 'validation_run') {
      expect(inRange.value.checks_run).toBe(9999)
    }
  })

  it('clamps client_day into [19000, 40000] (design §3.1)', () => {
    const low = validateEvent(validEventFor('app_boot', { client_day: 0 }))
    if (low.ok) expect(low.value.client_day).toBe(19_000)
    const high = validateEvent(validEventFor('app_boot', { client_day: 1_000_000 }))
    if (high.ok) expect(high.value.client_day).toBe(40_000)
  })

  it('rejects out-of-range values for non-clamped bounded integers', () => {
    expect(validateEvent(validEventFor('disclosure_shown', { disclosure_revision: 0 }))).toEqual({
      ok: false,
      error: 'out-of-range',
    })
    expect(validateEvent(validEventFor('diff_run', { aspects_count: 5 }))).toEqual({
      ok: false,
      error: 'out-of-range',
    })
    expect(validateEvent(validEventFor('app_boot', { app_version_major: 1000 }))).toEqual({
      ok: false,
      error: 'out-of-range',
    })
    expect(validateEvent(validEventFor('app_boot', { schema_version: 2 }))).toEqual({
      ok: false,
      error: 'out-of-range',
    })
  })

  it('rejects a non-integer or non-number for a bounded integer', () => {
    expect(validateEvent(validEventFor('diff_run', { aspects_count: 1.5 })).ok).toBe(false)
    expect(validateEvent(validEventFor('diff_run', { aspects_count: '1' })).ok).toBe(false)
    expect(validateEvent(validEventFor('diff_run', { aspects_count: Number.NaN })).ok).toBe(false)
  })

  it('enforces the exact token grammar', () => {
    const good = validateEvent(
      validEventFor('app_boot', { install_token: 'a'.repeat(32), session_token: 'b'.repeat(16) }),
    )
    expect(good.ok).toBe(true)
    const short = validateEvent(validEventFor('app_boot', { install_token: 'a'.repeat(31) }))
    expect(short).toEqual({ ok: false, error: 'invalid-token' })
    const upper = validateEvent(validEventFor('app_boot', { install_token: 'A'.repeat(32) }))
    expect(upper).toEqual({ ok: false, error: 'invalid-token' })
    const nonHex = validateEvent(validEventFor('app_boot', { session_token: 'z'.repeat(16) }))
    expect(nonHex).toEqual({ ok: false, error: 'invalid-token' })
    const number = validateEvent(validEventFor('app_boot', { install_token: 12345 }))
    expect(number).toEqual({ ok: false, error: 'wrong-type' })
  })
})

describe('validateEvent — hostile input and unknown fields (design §9, R1/R11)', () => {
  it('rejects the reserved pipeline_run as an unknown event for schema v1', () => {
    expect(validateEvent(validEventFor('app_boot', { event: 'pipeline_run' }))).toEqual({
      ok: false,
      error: 'unknown-event',
    })
  })

  it('rejects an unknown event name without echoing it', () => {
    const result = validateEvent({ event: 'exfiltrate_everything' })
    expect(result).toEqual({ ok: false, error: 'unknown-event' })
    expect(JSON.stringify(result)).not.toContain('exfiltrate')
  })

  it('rejects unknown/extra fields and never carries their value', () => {
    for (const field of ['filename', 'path', 'sql_text', 'column_names', 'error_message', 'argv']) {
      const payload = validateEvent(validEventFor('app_boot', { [field]: 'canary-secret-value' }))
      expect(payload, field).toEqual({ ok: false, error: 'unknown-field' })
      expect(JSON.stringify(payload), field).not.toContain('canary-secret-value')
    }
  })

  it('rejects a missing required field', () => {
    const payload = validEventFor('app_boot')
    delete payload['os_family']
    expect(validateEvent(payload)).toEqual({ ok: false, error: 'missing-field' })
  })

  it('never throws for non-object and primitive inputs (total)', () => {
    const inputs: readonly unknown[] = [
      null,
      undefined,
      0,
      42,
      Number.NaN,
      'a string',
      true,
      Symbol('x'),
      () => undefined,
      [],
      [validEventFor('app_boot')],
    ]
    for (const input of inputs) {
      expect(() => validateEvent(input)).not.toThrow()
      expect(validateEvent(input).ok).toBe(false)
    }
  })

  it('degrades hostile proxy-like objects to a typed rejection, never throwing', () => {
    const throwingProxy = new Proxy(
      {},
      {
        get() {
          throw new Error('get trap')
        },
        has() {
          throw new Error('has trap')
        },
        ownKeys() {
          throw new Error('ownKeys trap')
        },
        getOwnPropertyDescriptor() {
          throw new Error('getOwnPropertyDescriptor trap')
        },
      },
    )
    expect(() => validateEvent(throwingProxy)).not.toThrow()
    expect(validateEvent(throwingProxy).ok).toBe(false)

    const throwingGetter = { ...validEventFor('app_boot') }
    Object.defineProperty(throwingGetter, 'install_token', {
      enumerable: true,
      get() {
        throw new Error('getter')
      },
    })
    expect(() => validateEvent(throwingGetter)).not.toThrow()
    expect(validateEvent(throwingGetter).ok).toBe(false)
  })

  it('R1: no canary from the corpus survives validation into a payload', () => {
    for (const event of EVENTS) {
      for (const field of Object.keys(EVENT_SCHEMAS[event].fields)) {
        for (const canary of CANARY_CORPUS) {
          const result = validateEvent(validEventFor(event, { [field]: canary }))
          expect(result.ok, `${event}.${field}`).toBe(false)
          expect(JSON.stringify(result)).not.toContain(canary)
        }
      }
    }
    // And an unknown field cannot smuggle a canary through either.
    for (const canary of CANARY_CORPUS) {
      const result = validateEvent(validEventFor('dataset_opened', { notes: canary }))
      expect(result.ok).toBe(false)
      expect(JSON.stringify(result)).not.toContain(canary)
    }
  })

  it('R3: failure events expose only the closed reason_code enum', () => {
    const withMessage = validateEvent(
      validEventFor('dataset_open_failed', {
        reason_code: 'unknown',
        reason_message: 'SQL error: SELECT * FROM patients',
      }),
    )
    expect(withMessage).toEqual({ ok: false, error: 'unknown-field' })
    const result = validateEvent(validEventFor('dataset_open_failed', { reason_code: 'unknown' }))
    expect(result.ok).toBe(true)
    if (result.ok && result.value.event === 'dataset_open_failed') {
      expect(result.value.reason_code).toBe('unknown')
    }
  })

  it('D11: a reason code concatenated with a message is not an enum member', () => {
    expect(
      validateEvent(validEventFor('dataset_open_failed', { reason_code: 'unknown: SELECT 1' })),
    ).toEqual({ ok: false, error: 'invalid-enum' })
  })
})

describe('validateEvent — property: validate∘build round-trips', () => {
  it('validates a generated event for every active event', () => {
    for (const event of EVENTS) {
      const result = validateEvent(validEventFor(event))
      expect(result.ok, event).toBe(true)
      if (result.ok) {
        const typed: TelemetryEvent = result.value
        expect(typed.event).toBe(event)
      }
    }
  })
})
