// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import {
  ENVELOPE_SCHEMA,
  EVENTS,
  EVENT_SCHEMAS,
  bucketDuration,
  createTelemetryCore,
  generateInstallToken,
  generateSessionToken,
  isTelemetryEnabled,
  validateEndpoint,
  validateEvent,
} from './index.js'
import { CANARY_CORPUS, containsCanary, digestForValue, validEventFor } from './test-support.js'

interface ImportMetaWithGlob {
  glob: (
    pattern: string,
    options: { query: string; import: string; eager: true },
  ) => Record<string, string>
}

const SOURCES = (import.meta as unknown as ImportMetaWithGlob).glob('./*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
})

/** Source tokens that would prove a network/fs/timer/child-process surface. */
const FORBIDDEN_SOURCE_TOKENS = [
  'fetch(',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'navigator.',
  'localStorage',
  'sessionStorage',
  'setTimeout(',
  'setInterval(',
  'queueMicrotask(',
  'process.',
  'child_process',
  'readFile',
  'writeFile',
  'createHash',
  'createHmac',
] as const

function nonTestSources(): readonly [string, string][] {
  return Object.entries(SOURCES).filter(([path]) => !path.endsWith('.test.ts'))
}

describe('§7 red lines — t-1-applicable', () => {
  it('R1: no canary (SQL, paths, columns, cells, argv) survives validation', () => {
    for (const event of EVENTS) {
      for (const field of Object.keys(EVENT_SCHEMAS[event].fields)) {
        for (const canary of CANARY_CORPUS) {
          const result = validateEvent(validEventFor(event, { [field]: canary }))
          expect(result.ok).toBe(false)
          expect(containsCanary(result)).toBe(false)
        }
      }
    }
  })

  it('R2: every field is enum/boolean/bounded-int/token; none is a free-form string', () => {
    const specs = [
      ...Object.values(ENVELOPE_SCHEMA),
      ...EVENTS.flatMap((event) => Object.values(EVENT_SCHEMAS[event].fields)),
    ]
    for (const spec of specs) {
      expect(['enum', 'boolean', 'bounded-int', 'token']).toContain(spec.kind)
    }
  })

  it('R3: failure events carry only a closed reason_code/outcome enum', () => {
    const result = validateEvent(
      validEventFor('dataset_open_failed', {
        reason_code: 'unknown',
        stack: 'Error: at /home/user/secret.parquet',
      }),
    )
    expect(result).toEqual({ ok: false, error: 'unknown-field' })
  })

  it('R4: only key_mode is representable — key column names are rejected', () => {
    const result = validateEvent(validEventFor('diff_run', { key_columns: ['patient_id'] }))
    expect(result).toEqual({ ok: false, error: 'unknown-field' })
    const keyMode = validateEvent(validEventFor('diff_run', { key_mode: 'inferred' }))
    expect(keyMode.ok).toBe(true)
  })

  it('R5: no raw user-agent/URL/hostname field is representable', () => {
    for (const field of ['user_agent', 'url', 'referrer', 'hostname', 'username', 'email']) {
      expect(validateEvent(validEventFor('app_boot', { [field]: 'raw-value' }))).toEqual({
        ok: false,
        error: 'unknown-field',
      })
    }
  })

  it('R6: no endpoint configured ⇒ disabled, and no network surface exists', () => {
    const core = createTelemetryCore({
      endpoint: undefined,
      installToken: generateInstallToken(),
      sessionToken: generateSessionToken(),
    })
    expect(core.enabled).toBe(false)
    expect(isTelemetryEnabled(undefined)).toBe(false)
  })

  it('R6/R12/R13: every source module imports only relative modules (no SDK/fs/network)', () => {
    const sources = nonTestSources()
    // Guard against a vacuous scan (the glob must actually see the modules).
    expect(sources.length).toBeGreaterThanOrEqual(8)
    expect(sources.map(([path]) => path).join(',')).toContain('schema.ts')
    expect(sources.map(([path]) => path).join(',')).toContain('sampling.ts')
    const offenders: string[] = []
    for (const [path, source] of sources) {
      const specifiers = [
        ...[...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((match) => match[1] as string),
        ...[...source.matchAll(/\bimport\s+['"]([^'"]+)['"]/g)].map((match) => match[1] as string),
      ]
      for (const specifier of specifiers) {
        if (!specifier.startsWith('./')) offenders.push(`${path} imports ${specifier}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('R6/R12/R13: no non-test source contains a network/fs/timer/child-process token', () => {
    const offenders: string[] = []
    for (const [path, source] of nonTestSources()) {
      for (const token of FORBIDDEN_SOURCE_TOKENS) {
        if (source.includes(token)) offenders.push(`${path} contains ${token}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('R6/R12: the module performs zero egress even with fetch armed to throw', async () => {
    const key = 'fetch'
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: () => {
        throw new Error('network egress attempted')
      },
    })
    try {
      const core = createTelemetryCore({
        endpoint: 'https://collector.example',
        installToken: generateInstallToken(),
        sessionToken: generateSessionToken(),
      })
      await core.shouldEmit('query_run', { localSeq: 1 })
      validateEvent(validEventFor('validation_run'))
      validateEndpoint('https://collector.example')
      bucketDuration(123)
      await Promise.resolve()
    } finally {
      if (descriptor !== undefined) Object.defineProperty(globalThis, key, descriptor)
      else Reflect.deleteProperty(globalThis, key)
    }
  })

  it('R7: a disabled core constructs or samples zero events', async () => {
    let constructions = 0
    const core = createTelemetryCore({
      endpoint: undefined,
      installToken: generateInstallToken(),
      sessionToken: generateSessionToken(),
    })
    for (const event of EVENTS) {
      const emitted = await core.shouldEmit(event, { localSeq: constructions })
      if (emitted) constructions += 1
    }
    expect(constructions).toBe(0)
  })

  it('R10: the descriptor pins the full schema (any added field would change the snapshot)', () => {
    expect(Object.keys(EVENT_SCHEMAS).sort()).toEqual([...EVENTS].sort())
    expect(Object.keys(EVENT_SCHEMAS).length).toBe(9)
  })
})

describe('Appendix A leak drills — the t-1-applicable subset', () => {
  it('D1: raw SQL/driver error text cannot be attached to a failure event', () => {
    const result = validateEvent(
      validEventFor('dataset_open_failed', { driver_error: 'SELECT 1 -- secret' }),
    )
    expect(result).toEqual({ ok: false, error: 'unknown-field' })
  })

  it('D2: no filename/path field exists; unknown format is an enum, not the extension', () => {
    expect(validateEvent(validEventFor('dataset_opened', { filename: 'a.parquet' }))).toEqual({
      ok: false,
      error: 'unknown-field',
    })
    expect(validateEvent(validEventFor('dataset_opened', { format_kind: '.parquet' }))).toEqual({
      ok: false,
      error: 'invalid-enum',
    })
    expect(validateEvent(validEventFor('dataset_opened', { format_kind: 'unknown' })).ok).toBe(true)
  })

  it('D3: version is three bounded integers — a version string is rejected', () => {
    expect(validateEvent(validEventFor('app_boot', { app_version: '1.2.3-beta' }))).toEqual({
      ok: false,
      error: 'unknown-field',
    })
    expect(validateEvent(validEventFor('app_boot', { app_version_patch: '3' })).ok).toBe(false)
  })

  it('D4: --key column names are never read; only key_mode is representable', () => {
    expect(validateEvent(validEventFor('diff_run', { key: 'patient_id' }))).toEqual({
      ok: false,
      error: 'unknown-field',
    })
  })

  it('D5: contract rule text/allowed values have no field', () => {
    expect(
      validateEvent(validEventFor('validation_run', { rule_text: 'not null allowed values' })),
    ).toEqual({ ok: false, error: 'unknown-field' })
    const result = validateEvent(validEventFor('validation_run', { checks_run: 7 }))
    expect(result.ok).toBe(true)
  })

  it('D6: counts are clamped small integers and durations are coarse buckets', () => {
    const result = validateEvent(validEventFor('validation_run', { checks_run: 10 ** 12 }))
    expect(result.ok).toBe(true)
    if (result.ok && result.value.event === 'validation_run') {
      expect(result.value.checks_run).toBe(10_000)
    }
    expect(validateEvent(validEventFor('validation_run', { duration_bucket: '123456ms' }))).toEqual(
      {
        ok: false,
        error: 'invalid-enum',
      },
    )
  })

  it('D7: no path-derived field exists', () => {
    expect(validateEvent(validEventFor('dataset_opened', { path_kind: 'nested' }))).toEqual({
      ok: false,
      error: 'unknown-field',
    })
  })

  it('D9: tokens are CSPRNG, fixed-grammar, and never derived from inputs', () => {
    const token = generateInstallToken()
    expect(token).toMatch(/^[0-9a-f]{32}$/)
    expect(generateInstallToken()).not.toBe(token)
    expect(validateEvent(validEventFor('app_boot', { install_token: 'user-controlled' }))).toEqual({
      ok: false,
      error: 'invalid-token',
    })
  })

  it('D12: a raw argv blob is rejected as an unknown field', () => {
    expect(
      validateEvent(validEventFor('app_boot', { argv: ['assay', '--key', 'patient_id'] })),
    ).toEqual({ ok: false, error: 'unknown-field' })
  })
})

describe('seeded property suite — hostile canary corpus never survives', () => {
  function mulberry32(seed: number): () => number {
    let state = seed >>> 0
    return () => {
      state = (state + 0x6d2b79f5) | 0
      let t = Math.imul(state ^ (state >>> 15), 1 | state)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  it('rejects every seeded mutation of a valid event', () => {
    const random = mulberry32(20260929)
    for (let iteration = 0; iteration < 300; iteration++) {
      const event = EVENTS[Math.floor(random() * EVENTS.length)] as (typeof EVENTS)[number]
      const fields = Object.keys(EVENT_SCHEMAS[event].fields)
      const field = fields[Math.floor(random() * fields.length)] as string
      const canary = CANARY_CORPUS[Math.floor(random() * CANARY_CORPUS.length)] as string
      const result = validateEvent(validEventFor(event, { [field]: canary }))
      expect(result.ok, `${event}.${field} iteration=${iteration}`).toBe(false)
      expect(containsCanary(result)).toBe(false)
    }
  })

  it('sampling is deterministic for the same seeded context', async () => {
    const sampler = createTelemetryCore({
      endpoint: 'https://collector.example',
      installToken: generateInstallToken(),
      sessionToken: generateSessionToken(),
      hmac: async () => digestForValue(123),
      rates: { query_run: 500 },
    })
    const decisions = await Promise.all([
      sampler.shouldEmit('query_run', { localSeq: 1 }),
      sampler.shouldEmit('query_run', { localSeq: 1 }),
      sampler.shouldEmit('query_run', { localSeq: 1 }),
    ])
    expect(new Set(decisions).size).toBe(1)
  })
})
