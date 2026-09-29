// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Endpoint validation and the inert-by-default gate (design §8.2, §6.4; R6).
 *
 * This is the **pure** endpoint representation. Sourcing the endpoint string
 * from the environment / build-time config, the optional transport token, and
 * the operator docs are the emission-surface task's boundary (t-3) — this
 * module only decides whether a given value is a usable collector endpoint.
 *
 * Rules (design §8.2):
 * - `https://` is always permitted;
 * - `http://` is permitted only for loopback hosts (`localhost`, `127.0.0.1`,
 *   `[::1]`);
 * - credentials in the URL are rejected (the optional token is transport-only);
 * - unset/empty/malformed/wrong-scheme ⇒ disabled (silent no-op upstream).
 */

/** Why an endpoint value was rejected. */
export const ENDPOINT_REJECTIONS = [
  'missing',
  'malformed',
  'unsupported-scheme',
  'insecure-cleartext',
  'credentials',
] as const
export type EndpointRejection = (typeof ENDPOINT_REJECTIONS)[number]

/** A validated endpoint (normalized URL) or a closed rejection reason. */
export type EndpointValidation =
  | { readonly ok: true; readonly href: string }
  | { readonly ok: false; readonly reason: EndpointRejection }

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Validate a candidate collector endpoint. Total: any non-string, blank, or
 * unparseable value is a typed rejection, never a throw.
 */
export function validateEndpoint(value: unknown): EndpointValidation {
  if (typeof value !== 'string' || value.trim() === '') {
    return { ok: false, reason: 'missing' }
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'credentials' }
  }
  if (url.protocol === 'https:') return { ok: true, href: url.href }
  if (url.protocol === 'http:') {
    return LOOPBACK_HOSTS.has(url.hostname)
      ? { ok: true, href: url.href }
      : { ok: false, reason: 'insecure-cleartext' }
  }
  return { ok: false, reason: 'unsupported-scheme' }
}

/**
 * The pure "is telemetry enabled" gate for a candidate endpoint. The emission
 * surfaces compose this with the opt-out/preference gate (design §6.4); when
 * this is `false` nothing is constructed, sampled, buffered, or sent.
 */
export function isTelemetryEnabled(endpoint: unknown): boolean {
  return validateEndpoint(endpoint).ok
}
