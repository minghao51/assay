// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Total event validator (design §3, §9; ADR 0045).
 *
 * `validateEvent` is **total**: it never throws for any input — non-objects,
 * primitives, arrays, symbols, and hostile proxy-like objects all degrade to a
 * typed rejection. It is driven entirely by the {@link ENVELOPE_SCHEMA} /
 * {@link EVENT_SCHEMAS} descriptor, so there is no hand-coded field list to
 * drift from the schema.
 *
 * Rejections never echo the input: the rejected result carries only a closed
 * {@link ValidationErrorCode}. An unknown field or unknown event (including
 * the reserved `pipeline_run`) is rejected rather than copied, so hostile text
 * cannot survive validation into a payload (design R1/R11, §9).
 *
 * Clamps (design §3.1 `client_day`, §3.6 `checks_run`) are applied here: the
 * returned event carries the clamped value, never the original.
 */

import {
  ENVELOPE_SCHEMA,
  EVENTS,
  EVENT_SCHEMAS,
  type EventName,
  type FieldSpec,
  type TelemetryEvent,
} from './schema.js'
import { isHexOfLength } from './tokens.js'

/** The closed set of typed validation outcomes (never free text). */
export const VALIDATION_ERRORS = [
  'not-an-object',
  'unreadable-input',
  'unknown-event',
  'unknown-field',
  'missing-field',
  'wrong-type',
  'invalid-enum',
  'invalid-token',
  'out-of-range',
] as const

export type ValidationErrorCode = (typeof VALIDATION_ERRORS)[number]

/**
 * A validation result. The success arm carries a fully typed
 * {@link TelemetryEvent}; the failure arm carries only a closed error code —
 * never a copy of the rejected input.
 */
export type ValidationResult =
  | { readonly ok: true; readonly value: TelemetryEvent }
  | { readonly ok: false; readonly error: ValidationErrorCode }

interface FieldSuccess {
  readonly ok: true
  readonly value: unknown
}
interface FieldFailure {
  readonly ok: false
  readonly error: ValidationErrorCode
}

function validateField(spec: FieldSpec, value: unknown): FieldSuccess | FieldFailure {
  switch (spec.kind) {
    case 'enum': {
      if (typeof value !== 'string') return { ok: false, error: 'wrong-type' }
      return spec.values.includes(value)
        ? { ok: true, value }
        : { ok: false, error: 'invalid-enum' }
    }
    case 'boolean':
      return typeof value === 'boolean' ? { ok: true, value } : { ok: false, error: 'wrong-type' }
    case 'bounded-int': {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        return { ok: false, error: 'wrong-type' }
      }
      if (value < spec.min) {
        return spec.clamp === true
          ? { ok: true, value: spec.min }
          : { ok: false, error: 'out-of-range' }
      }
      if (value > spec.max) {
        return spec.clamp === true
          ? { ok: true, value: spec.max }
          : { ok: false, error: 'out-of-range' }
      }
      return { ok: true, value }
    }
    case 'token':
      if (typeof value !== 'string') return { ok: false, error: 'wrong-type' }
      return isHexOfLength(value, spec.length)
        ? { ok: true, value }
        : { ok: false, error: 'invalid-token' }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isEventName(value: string): value is EventName {
  return (EVENTS as readonly string[]).includes(value)
}

function validateEventInner(input: unknown): ValidationResult {
  if (!isPlainObject(input)) return { ok: false, error: 'not-an-object' }

  if (!Object.hasOwn(input, 'event')) return { ok: false, error: 'unknown-event' }
  const event = input['event']
  if (typeof event !== 'string' || !isEventName(event)) {
    return { ok: false, error: 'unknown-event' }
  }

  const payloadSchema = EVENT_SCHEMAS[event].fields
  const allowed = new Set<string>([...Object.keys(ENVELOPE_SCHEMA), ...Object.keys(payloadSchema)])
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) return { ok: false, error: 'unknown-field' }
  }

  const validated: Record<string, unknown> = {}
  for (const [field, spec] of Object.entries(ENVELOPE_SCHEMA)) {
    if (!Object.hasOwn(input, field)) return { ok: false, error: 'missing-field' }
    const result = validateField(spec, input[field])
    if (!result.ok) return result
    validated[field] = result.value
  }
  for (const [field, spec] of Object.entries(payloadSchema)) {
    if (!Object.hasOwn(input, field)) return { ok: false, error: 'missing-field' }
    const result = validateField(spec, input[field])
    if (!result.ok) return result
    validated[field] = result.value
  }

  // Sound by construction: every envelope and payload field was validated
  // against the descriptor above, and unknown fields were rejected, so the
  // sanitized record is exactly a `TelemetryEvent`. The descriptor guarantees
  // the payload matches the narrative `event` discriminant.
  return { ok: true, value: validated as unknown as TelemetryEvent }
}

/**
 * Validate an untrusted value into a typed telemetry event. Total
 * (never-throwing): any malformed input — including hostile/proxy objects —
 * returns a typed rejection carrying only a closed error code.
 */
export function validateEvent(input: unknown): ValidationResult {
  try {
    return validateEventInner(input)
  } catch {
    // A proxy/getter/ownKeys trap threw while reading the input; treat it as
    // unreadable rather than letting the exception escape (total validator).
    return { ok: false, error: 'unreadable-input' }
  }
}
