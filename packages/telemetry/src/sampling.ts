// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Client-side sampling (design §5).
 *
 * Rates are per-mille, compiled-in defaults, and applied **before any event is
 * constructed, buffered, or sent**: the predicate takes no payload, so there
 * is nothing to construct inside it. §5.1:
 *
 * ```text
 * included := rate === 1000
 *          OR firstOfSession
 *          OR errorOrCancel
 *          OR hmac_sha256(install_token, session_token || event || local_seq) mod 1000 < rate
 * ```
 *
 * The HMAC-SHA256 comes from the platform Web Crypto (`globalThis.crypto.subtle`)
 * — no hand-rolled primitive and no hash dependency (ADR 0007). The hash is
 * deterministic, so a given `(install, session, event, seq)` is consistently
 * in or out. Token access is lazy: the rate-1000 / bypass paths never touch a
 * token, and the HMAC path only reads them when it runs.
 *
 * The message is the UTF-8 bytes of `session_token + event + String(local_seq)`
 * and the key is the UTF-8 bytes of `install_token`; the digest is read as a
 * big-endian unsigned integer and reduced modulo 1000. `local_seq` is never
 * sent (design §5.1).
 *
 * Build/deploy overrides are injected via {@link SamplerConfig.rates} (the
 * emission surfaces own env/build-time sourcing, design §5.3); the collector
 * can never change a rate at runtime.
 */

import {
  BYPASS_OUTCOMES,
  EVENTS,
  type EventName,
  type InstallToken,
  type SessionToken,
  type TelemetryOutcome,
} from './schema.js'

/** The §5 compiled-in per-mille defaults. */
export const DEFAULT_RATES_PER_MILLE: Readonly<Record<EventName, number>> = {
  app_boot: 1000,
  disclosure_shown: 1000,
  dataset_opened: 1000,
  dataset_open_failed: 1000,
  validation_run: 1000,
  diff_run: 1000,
  export_run: 1000,
  profile_run: 250,
  query_run: 100,
}

/** Per-mille scale ceiling (1000‰ == always send). */
export const MAX_RATE_PER_MILLE = 1000

/** One HMAC-SHA256 over raw bytes; injectable for tests and environment seams. */
export type HmacSha256 = (
  key: Uint8Array<ArrayBuffer>,
  message: Uint8Array<ArrayBuffer>,
) => Promise<Uint8Array>

/**
 * The platform HMAC-SHA256 (Web Crypto, ADR 0007). `globalThis.crypto` is a
 * standard global in Node ≥ 22 and all browsers.
 */
export async function platformHmacSha256(
  key: Uint8Array<ArrayBuffer>,
  message: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array> {
  const keyHandle = await globalThis.crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await globalThis.crypto.subtle.sign('HMAC', keyHandle, message)
  return new Uint8Array(signature)
}

/**
 * Reduce a digest to its per-mille bucket: the big-endian unsigned integer
 * value of the bytes, modulo 1000 (design §5.1 `mod 1000`).
 */
export function bucketOfDigest(digest: Uint8Array): number {
  let value = 0n
  for (const byte of digest) value = (value << 8n) | BigInt(byte)
  return Number(value % 1000n)
}

/**
 * Input to a sampling decision. Token access is lazy (a function) so the
 * always-send and rate-1000 paths do no token work.
 */
export interface SamplingContext {
  readonly event: EventName
  /** Per-session monotonic counter; hashed locally and never sent. */
  readonly localSeq: number
  readonly installToken: () => InstallToken
  readonly sessionToken: () => SessionToken
  /** e.g. the first query of a session (design §5 exceptions). */
  readonly firstOfSession?: boolean
  /** The event's outcome, if any; errors/cancellations bypass sampling. */
  readonly outcome?: TelemetryOutcome
}

/** An async in/out decision for one event; `true` means construct and keep. */
export type Sampler = (context: SamplingContext) => Promise<boolean>

export interface SamplerConfig {
  /** Per-event per-mille overrides; out-of-range values are clamped 0–1000. */
  readonly rates?: Partial<Record<EventName, number>>
  /** HMAC implementation; defaults to the platform Web Crypto one. */
  readonly hmac?: HmacSha256
}

/** Clamp an injected override into an integer per-mille rate. */
function sanitizeRate(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(MAX_RATE_PER_MILLE, Math.max(0, Math.trunc(value)))
}

/** The compiled-in defaults merged with clamped injected overrides. */
export function resolveRates(
  overrides?: Partial<Record<EventName, number>>,
): Readonly<Record<EventName, number>> {
  const rates: Record<EventName, number> = { ...DEFAULT_RATES_PER_MILLE }
  if (overrides !== undefined) {
    for (const event of EVENTS) {
      const override = overrides[event]
      if (override !== undefined) rates[event] = sanitizeRate(override, rates[event])
    }
  }
  return rates
}

/**
 * Build a sampler from the compiled-in rates plus optional overrides and an
 * optional HMAC implementation.
 */
export function createSampler(config: SamplerConfig = {}): Sampler {
  const hmac = config.hmac ?? platformHmacSha256
  const rates = resolveRates(config.rates)
  const bypass = new Set<string>(BYPASS_OUTCOMES)
  return async (context) => {
    const rate = rates[context.event]
    // §5.1: rate 1000, first-of-session, and error/cancel bypass; none of
    // these touch the tokens or run the HMAC.
    if (rate >= MAX_RATE_PER_MILLE) return true
    if (context.firstOfSession === true) return true
    if (context.outcome !== undefined && bypass.has(context.outcome)) return true
    // `bucket < 0` is never true, so a zero rate skips the HMAC entirely.
    if (rate <= 0) return false
    const key = new TextEncoder().encode(context.installToken())
    const message = new TextEncoder().encode(
      `${context.sessionToken()}${context.event}${String(context.localSeq)}`,
    )
    const digest = await hmac(key, message)
    return bucketOfDigest(digest) < rate
  }
}
