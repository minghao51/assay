// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Assay telemetry collector — the reference deployment on Netlify Functions
 * (ADR 0053; operator contract `docs/engineering/07-telemetry-collector.md` §2,
 * reference deployment §5).
 *
 * ## What it accepts
 *
 * `POST` with `content-type: application/json` whose body is a JSON **array of
 * event objects** — the wire shape the shipped client sends (contract §2,
 * `packages/telemetry/src/buffer.ts` `splitIntoBatches`). Every element is
 * validated with `validateEvent` from `@assay/telemetry`: the descriptor, the
 * closed nine-event allowlist, the enum tables, the bounded integers and the
 * fixed-grammar tokens are **the package's**, not a copy of them. There is no
 * local field list to drift, and no field can carry free-form text (ADR 0045).
 * Validation is strict: one invalid element refuses the whole batch with `400`
 * (the contract permits strict mode, §2.1) — nothing is coerced, dropped or
 * stored.
 *
 * `OPTIONS` answers a CORS preflight. Every other method is refused with `405`
 * and an `Allow` header. Refusals return a closed, value-free reason code and
 * never echo the request.
 *
 * ## What it does with an accepted batch: nothing
 *
 * Nothing is persisted, forwarded, queued or logged. This deployment is a
 * well-formedness sink: it proves the endpoint exists, that the schema is
 * enforced, and that the client's wire shape reaches a server. The contract's
 * storage/retention table (§3: raw events 90 days, aggregates 24 months, no
 * IPs, logs ≤ 14 days) is an **operator obligation this function deliberately
 * does not improvise** — inventing a store here would mean shipping an
 * unreviewed database holding install tokens. Add storage deliberately, with
 * the retention jobs, before treating this endpoint as an analytics source.
 * There is also no rate limiter: reading the caller's address is the one thing
 * this file refuses to do (contract §3 "IP addresses never persisted"; the
 * client already caps batches at 32 events / 256 KiB and rate-limits
 * `dataset_opened`).
 *
 * ## Privacy: the logs are value-free by construction
 *
 * The handler never reads the `user-agent`, any forwarded-for header, the
 * request URL's query string, or any payload value; it never logs a body, a
 * header value or a payload field. A refusal logs a fixed prefix plus closed
 * reason codes only — that is a deliberate design choice (ADR 0025), and
 * `collect.test.ts` pins it by asserting the exact console calls and by
 * submitting canary values and asserting none of them appear in the response or
 * the captured console output.
 *
 * ## CORS: same-origin by default, never a wildcard
 *
 * The contract does not pin an origin, so the narrowest thing that works is the
 * default: the site serves the app and `/.netlify/functions/collect` from one
 * origin, so no CORS header is needed at all. An operator who must call the
 * endpoint from a different origin opts it in explicitly with
 * `ASSAY_TELEMETRY_ALLOWED_ORIGINS` (comma-separated exact origins); only then
 * is the matching `Origin` echoed back. `access-control-allow-origin: *` is
 * never sent — a wildcard would let any page on the web post into the
 * collector.
 *
 * ## Totality
 *
 * `handler` never lets a throw escape: a request whose body stream rejects, or
 * a hostile stub, still gets a `500` with the same value-free body. An
 * unhandled rejection in the function log would print a stack and context this
 * file does not control, so the failure path is caught here on purpose.
 */

import {
  MAX_BATCH_BYTES,
  MAX_BATCH_EVENTS,
  validateEvent,
  type ValidationErrorCode,
} from '@assay/telemetry'

/**
 * Array-framing headroom above the client's per-batch byte cap.
 *
 * The client caps a batch at `MAX_BATCH_BYTES` (256 KiB) of *serialized events*
 * (`buffer.ts`); the request body is that same array serialized, so brackets
 * and at most 31 commas are added on top of the counted bytes. This allowance
 * exists so a maximal legitimate client batch is never refused for its framing;
 * it is not headroom for a larger batch, and it is far below Netlify's own
 * request-body ceiling.
 */
const FRAMING_HEADROOM_BYTES = 1024

/**
 * Hard request-body cap (contract §2 "≤ 256 KiB per request"). A body above it
 * is refused with `413` before any parsing, so a hostile caller cannot make the
 * function buffer and parse an unbounded payload.
 */
export const MAX_REQUEST_BYTES = MAX_BATCH_BYTES + FRAMING_HEADROOM_BYTES

/**
 * Batch cap (contract §2 "≤ 32 events per request"): the client never sends
 * more, so a larger array is a client bug or an attempted abuse, and a batch of
 * zero events is never produced by the shipped client either (it flushes only
 * non-empty buffers) — both are refused instead of quietly accepted.
 */
export const MAX_EVENTS_PER_REQUEST = MAX_BATCH_EVENTS

/** The environment variable an operator sets to allow a cross-origin caller. */
export const ALLOWED_ORIGINS_ENV = 'ASSAY_TELEMETRY_ALLOWED_ORIGINS'

/**
 * The collector's own refusal categories. Closed, so a refusal can be logged
 * and returned without carrying anything from the request. `invalid-event`
 * additionally carries one of the schema validator's closed error codes.
 */
export const COLLECTOR_REFUSALS = [
  'malformed-json',
  'not-an-array',
  'empty-batch',
  'batch-too-large',
  'body-too-large',
  'unsupported-media-type',
  'invalid-event',
  'method-not-allowed',
  'unexpected-error',
] as const

export type CollectorRefusal = (typeof COLLECTOR_REFUSALS)[number]

/** The accepted response body: no counts of payload content, nothing echoed. */
const ACCEPTED_BODY = '{"ok":true}'

/**
 * The collector entry point. Netlify's modern handler style is a default export
 * taking a web-standard `Request` and returning a web-standard `Response`, so
 * this file needs no `@netlify/functions` dependency.
 */
export default async function handler(request: Request): Promise<Response> {
  const origin = readOrigin(request)
  try {
    return await handle(request, origin)
  } catch {
    // Total by design: the failure path is still value-free.
    return refuse(500, 'unexpected-error', origin)
  }
}

async function handle(request: Request, origin: string | undefined): Promise<Response> {
  const method = request.method.toUpperCase()

  if (method === 'OPTIONS') return preflight(origin)
  if (method !== 'POST') {
    return refuse(405, 'method-not-allowed', origin, { allow: 'POST, OPTIONS' })
  }

  if (!isJsonContentType(request.headers.get('content-type'))) {
    return refuse(415, 'unsupported-media-type', origin)
  }

  // Advisory pre-check: `content-length` can be absent or wrong, so the byte
  // count after reading is the authoritative cap below.
  const declared = declaredLength(request)
  if (declared !== null && declared > MAX_REQUEST_BYTES) {
    return refuse(413, 'body-too-large', origin)
  }

  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.byteLength > MAX_REQUEST_BYTES) return refuse(413, 'body-too-large', origin)

  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return refuse(400, 'malformed-json', origin)
  }

  if (!Array.isArray(parsed)) return refuse(400, 'not-an-array', origin)
  if (parsed.length === 0) return refuse(400, 'empty-batch', origin)
  if (parsed.length > MAX_EVENTS_PER_REQUEST) return refuse(400, 'batch-too-large', origin)

  // The schema is the package's: descriptor-driven, allowlisted, total.
  for (const candidate of parsed) {
    const result = validateEvent(candidate)
    if (!result.ok) return refuse(400, 'invalid-event', origin, {}, result.error)
  }

  // Accepted and deliberately discarded — see the file header (no persistence,
  // no forwarding, no retention store invented here).
  return jsonResponse(202, ACCEPTED_BODY, origin)
}

/** Build a refusal: a closed reason code, never anything from the request. */
function refuse(
  status: number,
  reason: CollectorRefusal,
  origin: string | undefined,
  headers: Readonly<Record<string, string>> = {},
  detail?: ValidationErrorCode,
): Response {
  logRefusal(reason, detail)
  return jsonResponse(status, refusalBody(reason, detail), origin, headers)
}

/** The refusal body: `{"ok":false,"reason":…}` plus an optional closed detail. */
export function refusalBody(reason: CollectorRefusal, detail?: ValidationErrorCode): string {
  return detail === undefined
    ? `{"ok":false,"reason":${JSON.stringify(reason)}}`
    : `{"ok":false,"reason":${JSON.stringify(reason)},"detail":${JSON.stringify(detail)}}`
}

/**
 * Log a refusal as a fixed prefix plus closed codes — deliberately value-free
 * (ADR 0025). Never the body, a header, the URL, the method, the caller's
 * address or user agent, or any payload value; `collect.test.ts` asserts the
 * exact call arguments so an added value fails the suite.
 */
function logRefusal(reason: CollectorRefusal, detail?: ValidationErrorCode): void {
  const line = ['[telemetry-collector] refused:', reason]
  if (detail !== undefined) line.push(detail)
  if (reason === 'unexpected-error') console.error(...line)
  else console.warn(...line)
}

function jsonResponse(
  status: number,
  body: string,
  origin: string | undefined,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
      ...corsHeaders(origin),
    },
  })
}

/**
 * Answer a CORS preflight. Without a configured, matching origin this is a bare
 * `204`: a same-origin caller needs no grant, and a cross-origin caller we do
 * not serve gets none (its browser then blocks the request, as intended).
 */
function preflight(origin: string | undefined): Response {
  const headers: Record<string, string> = { 'cache-control': 'no-store' }
  if (origin !== undefined && isAllowedOrigin(origin)) {
    headers['access-control-allow-origin'] = origin
    headers['access-control-allow-methods'] = 'POST, OPTIONS'
    headers['access-control-allow-headers'] = 'content-type, authorization'
    headers['access-control-max-age'] = '86400'
  }
  if (origin !== undefined) headers['vary'] = 'origin'
  return new Response(null, { status: 204, headers })
}

/** Echo an allowed origin only; never `*`. */
function corsHeaders(origin: string | undefined): Record<string, string> {
  if (origin === undefined) return {}
  return isAllowedOrigin(origin)
    ? { 'access-control-allow-origin': origin, vary: 'origin' }
    : { vary: 'origin' }
}

/** Read the opt-in allowlist; empty (same-origin only) unless configured. */
function allowedOrigins(): readonly string[] {
  const raw = process.env[ALLOWED_ORIGINS_ENV] ?? ''
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

function isAllowedOrigin(origin: string): boolean {
  return allowedOrigins().includes(origin)
}

/** Exact media type only: `application/json`, with optional parameters. */
function isJsonContentType(value: string | null): boolean {
  if (value === null) return false
  const [mediaType] = value.split(';')
  return mediaType.trim().toLowerCase() === 'application/json'
}

/** The declared body length, or `null` when absent/unparsable. */
function declaredLength(request: Request): number | null {
  const raw = request.headers.get('content-length')
  if (raw === null) return null
  const value = Number(raw)
  return Number.isInteger(value) && value >= 0 ? value : null
}

/** The `Origin` header, read only to decide CORS; never logged. Total. */
function readOrigin(request: Request): string | undefined {
  try {
    const origin = request.headers.get('origin')
    return origin === null || origin === '' ? undefined : origin
  } catch {
    return undefined
  }
}
