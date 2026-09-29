// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Test support for the telemetry suite. Like `@assay/domain`'s
 * `property-testing.ts`, this module is **not** part of the public surface and
 * is never re-exported from `index.ts`; it exists so validators, samplers, and
 * property tests share one deterministic event builder and canary corpus.
 */

import { generateInstallToken, generateSessionToken } from './tokens.js'
import {
  ENVELOPE_SCHEMA,
  EVENT_SCHEMAS,
  SCHEMA_VERSION,
  type EventName,
  type FieldSpec,
} from './schema.js'

/** A representative valid value for a field spec (first enum member, bound minimum). */
export function sampleFieldValue(field: string, spec: FieldSpec): unknown {
  switch (spec.kind) {
    case 'enum':
      return spec.values[0] as string
    case 'boolean':
      return true
    case 'bounded-int':
      return field === 'schema_version' ? SCHEMA_VERSION : spec.min
    case 'token':
      return spec.length === 32 ? generateInstallToken() : generateSessionToken()
  }
}

/**
 * Build a fully valid (plain, JSON-shaped) event for `event`, then apply
 * `overrides`. Values come from the descriptor, so this stays in sync with the
 * schema automatically.
 */
export function validEventFor(
  event: EventName,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const built: Record<string, unknown> = {}
  for (const [field, spec] of Object.entries(ENVELOPE_SCHEMA)) {
    built[field] = sampleFieldValue(field, spec)
  }
  for (const [field, spec] of Object.entries(EVENT_SCHEMAS[event].fields)) {
    built[field] = sampleFieldValue(field, spec)
  }
  built['event'] = event
  return { ...built, ...overrides }
}

/**
 * Open/hostile strings that must never survive validation into a payload:
 * SQL text, paths, emails, column names, cell values, argv, script. Used by
 * the canary corpus tests (design R1, Appendix A).
 */
export const CANARY_CORPUS: readonly string[] = [
  "SELECT ssn, email FROM customers WHERE card = '4111 1111 1111 1111'",
  '/home/analyst/secret/patient_records_2026.parquet',
  'C:\\Users\\jdoe\\Documents\\payroll.csv',
  'john.doe@example.com',
  'customer_email_address',
  "Robert'); DROP TABLE users;--",
  '<script>alert(document.cookie)</script>',
  '--key patient_id',
  '{"cell":"top-secret-value"}',
  'Authorization: Bearer sk-live-0123456789',
]

/** A 32-byte big-endian digest whose value is `bucket`; `bucketOfDigest` → bucket mod 1000. */
export function digestForValue(value: number): Uint8Array {
  let remaining = BigInt(value)
  const bytes = new Uint8Array(32)
  for (let index = bytes.length - 1; index >= 0; index--) {
    bytes[index] = Number(remaining & 0xffn)
    remaining >>= 8n
  }
  return bytes
}

/** True iff any canary substring appears in a JSON rendering of `value`. */
export function containsCanary(value: unknown): boolean {
  const rendered = JSON.stringify(value)
  return CANARY_CORPUS.some((canary) => rendered.includes(canary))
}
