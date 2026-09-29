// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import {
  APP_BOOT_NO_FREE_STRING,
  DATASET_OPENED_NO_FREE_STRING,
  DATASET_OPEN_FAILED_NO_FREE_STRING,
  DIFF_RUN_NO_FREE_STRING,
  DISCLOSURE_SHOWN_NO_FREE_STRING,
  ENVELOPE_NO_FREE_STRING,
  ENVELOPE_SCHEMA,
  EVENT_SCHEMAS,
  EVENTS,
  EXPORT_RUN_NO_FREE_STRING,
  PROFILE_RUN_NO_FREE_STRING,
  QUERY_RUN_NO_FREE_STRING,
  RESERVED_EVENTS,
  RESERVED_PIPELINE_RUN,
  SCHEMA_VERSION,
  VALIDATION_RUN_NO_FREE_STRING,
  classifyOsFamily,
  eventSchemaFor,
  type EventName,
  type FieldKind,
  type FieldSpec,
} from './schema.js'

const ALLOWED_FIELD_KINDS: ReadonlySet<string> = new Set<FieldKind>([
  'enum',
  'boolean',
  'bounded-int',
  'token',
])

/** Pinned §4/R10 snapshot: the exact `(event, field)` set of schema v1. */
const ENVELOPE_SNAPSHOT = [
  'app_version_major',
  'app_version_minor',
  'app_version_patch',
  'client_day',
  'event',
  'install_token',
  'schema_version',
  'session_token',
  'surface',
] as const

const PAYLOAD_SNAPSHOT: Readonly<Record<EventName, readonly string[]>> = {
  app_boot: ['build_channel', 'engine_family', 'os_family'],
  disclosure_shown: ['disclosure_revision'],
  dataset_opened: [
    'column_count_bucket',
    'dataset_role',
    'format_kind',
    'row_count_bucket',
    'size_bucket',
  ],
  dataset_open_failed: ['dataset_role', 'format_kind', 'reason_code'],
  validation_run: ['checks_run', 'duration_bucket', 'finding_count_bucket', 'outcome'],
  diff_run: ['aspects_count', 'duration_bucket', 'key_mode', 'outcome'],
  profile_run: ['column_count_bucket', 'duration_bucket', 'outcome'],
  query_run: ['duration_bucket', 'outcome', 'query_kind', 'row_count_bucket'],
  export_run: ['outcome', 'row_count_bucket', 'target_format'],
}

function allSpecs(): readonly {
  readonly event: string
  readonly field: string
  readonly spec: FieldSpec
}[] {
  const specs: { event: string; field: string; spec: FieldSpec }[] = []
  for (const [field, spec] of Object.entries(ENVELOPE_SCHEMA)) {
    specs.push({ event: '(envelope)', field, spec })
  }
  for (const event of EVENTS) {
    for (const [field, spec] of Object.entries(EVENT_SCHEMAS[event].fields)) {
      specs.push({ event, field, spec })
    }
  }
  return specs
}

describe('schema v1 (design §3, ADR 0045)', () => {
  it('pins the schema version and the nine-event allowlist', () => {
    expect(SCHEMA_VERSION).toBe(1)
    expect(EVENTS).toEqual([
      'app_boot',
      'disclosure_shown',
      'dataset_opened',
      'dataset_open_failed',
      'validation_run',
      'diff_run',
      'profile_run',
      'query_run',
      'export_run',
    ])
    expect(EVENTS).toHaveLength(9)
  })

  it('R10: the descriptor matches the pinned §4 schema snapshot exactly', () => {
    expect(Object.keys(ENVELOPE_SCHEMA).sort()).toEqual([...ENVELOPE_SNAPSHOT])
    for (const event of EVENTS) {
      expect(Object.keys(EVENT_SCHEMAS[event].fields).sort()).toEqual([...PAYLOAD_SNAPSHOT[event]])
    }
    expect(Object.keys(PAYLOAD_SNAPSHOT).sort()).toEqual([...EVENTS].sort())
  })

  it('R10: expands to exactly 111 (event, field) rows (9×9 envelope + 30 payload)', () => {
    const envelopeRows = EVENTS.length * Object.keys(ENVELOPE_SCHEMA).length
    const payloadRows = EVENTS.reduce(
      (total, event) => total + Object.keys(EVENT_SCHEMAS[event].fields).length,
      0,
    )
    expect(envelopeRows + payloadRows).toBe(111)
    expect(payloadRows).toBe(30)
  })

  it('lists pipeline_run as reserved with no fields and no emitter', () => {
    expect(RESERVED_EVENTS).toEqual(['pipeline_run'])
    expect(RESERVED_PIPELINE_RUN.reserved).toBe(true)
    expect(RESERVED_PIPELINE_RUN.fields).toEqual({})
    expect(EVENTS).not.toContain('pipeline_run')
  })

  it('eventSchemaFor returns the descriptor for an active event', () => {
    expect(eventSchemaFor('app_boot')).toBe(EVENT_SCHEMAS.app_boot)
  })

  it('R2: every field kind is a closed enum/boolean/bounded-int/token — never a string', () => {
    for (const { event, field, spec } of allSpecs()) {
      expect(ALLOWED_FIELD_KINDS.has(spec.kind), `${event}.${field} kind=${spec.kind}`).toBe(true)
      expect(spec.kind, `${event}.${field}`).not.toBe('string')
    }
  })

  it('R2: the type-level no-free-form-string proof constants hold at runtime', () => {
    expect([
      ENVELOPE_NO_FREE_STRING,
      APP_BOOT_NO_FREE_STRING,
      DISCLOSURE_SHOWN_NO_FREE_STRING,
      DATASET_OPENED_NO_FREE_STRING,
      DATASET_OPEN_FAILED_NO_FREE_STRING,
      VALIDATION_RUN_NO_FREE_STRING,
      DIFF_RUN_NO_FREE_STRING,
      PROFILE_RUN_NO_FREE_STRING,
      QUERY_RUN_NO_FREE_STRING,
      EXPORT_RUN_NO_FREE_STRING,
    ]).toEqual([true, true, true, true, true, true, true, true, true, true])
  })

  it('D8: hostile platform/user-agent strings map to a coarse os_family enum', () => {
    expect(classifyOsFamily('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('windows')
    expect(classifyOsFamily('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('macos')
    expect(classifyOsFamily('Darwin 24.0.0')).toBe('macos')
    expect(classifyOsFamily('Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux')
    expect(classifyOsFamily('a'.repeat(500))).toBe('other')
    expect(classifyOsFamily('<script>alert(1)</script>')).toBe('other')
    expect(classifyOsFamily('')).toBe('other')
    expect(classifyOsFamily(undefined)).toBe('other')
    expect(classifyOsFamily({ ua: 'secret-fingerprint' })).toBe('other')
    expect(classifyOsFamily(42)).toBe('other')
  })
})
