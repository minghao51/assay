// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The pure telemetry core: the endpoint gate composed with sampling.
 *
 * `createTelemetryCore(config)` decides `enabled` once from the endpoint
 * (design §8.2) and exposes `shouldEmit(event, context)`, which returns the
 * combined "endpoint valid AND sampled in" decision. It deliberately owns NO
 * buffer, timer, transport, retry, or preference/env read — those are the
 * emission surfaces' job (t-2 buffer/opt-out, t-3 transport). This keeps the
 * module network/fs/timer-free (design R6/R9/R13).
 *
 * `shouldEmit` takes no payload, so an event cannot be constructed inside it:
 * the decision runs strictly before any event is built (design §5). Token
 * access is lazy and only happens on the HMAC path; a disabled core does zero
 * token or HMAC work (design §8.1/R6).
 */

import { isTelemetryEnabled } from './endpoint.js'
import { createSampler, type HmacSha256, type Sampler } from './sampling.js'
import type { EventName, InstallToken, SessionToken, TelemetryOutcome } from './schema.js'

/** Configuration for {@link createTelemetryCore}; all inputs are injected. */
export interface TelemetryCoreConfig {
  /** Candidate collector endpoint; invalid/unset ⇒ the core is disabled. */
  readonly endpoint: unknown
  /** The 128-bit install pseudonym, or a lazy provider for it. */
  readonly installToken: InstallToken | (() => InstallToken)
  /** The 64-bit session token, or a lazy provider for it. */
  readonly sessionToken: SessionToken | (() => SessionToken)
  /** Per-event per-mille overrides (compiled-in defaults otherwise). */
  readonly rates?: Partial<Record<EventName, number>>
  /** HMAC implementation override (tests / environment seams). */
  readonly hmac?: HmacSha256
}

/** Per-decision context for {@link TelemetryCore.shouldEmit}. */
export interface EmitContext {
  /** Per-session monotonic counter; hashed locally, never sent. */
  readonly localSeq: number
  /** Marks the first event of its kind in the session (design §5). */
  readonly firstOfSession?: boolean
  /** The event outcome, if any; errors/cancellations bypass sampling. */
  readonly outcome?: TelemetryOutcome
}

/** The pure decision surface consumed by the emission tasks. */
export interface TelemetryCore {
  /** `false` ⇒ nothing is constructed, sampled, buffered, or sent. */
  readonly enabled: boolean
  /** Combined endpoint + sampling decision for one event. */
  shouldEmit(event: EventName, context: EmitContext): Promise<boolean>
}

function tokenProvider<T extends string>(token: T | (() => T)): () => T {
  if (typeof token === 'function') return token
  return () => token
}

/**
 * Create the pure core. `enabled` is fixed at construction from the endpoint;
 * `shouldEmit` re-checks nothing else (the surfaces re-read opt-out per send,
 * design §6.4, and gate on `enabled`).
 */
export function createTelemetryCore(config: TelemetryCoreConfig): TelemetryCore {
  const enabled = isTelemetryEnabled(config.endpoint)
  const sampler: Sampler = createSampler({
    ...(config.rates !== undefined ? { rates: config.rates } : {}),
    ...(config.hmac !== undefined ? { hmac: config.hmac } : {}),
  })
  const installToken = tokenProvider(config.installToken)
  const sessionToken = tokenProvider(config.sessionToken)
  return {
    enabled,
    async shouldEmit(event, context) {
      if (!enabled) return false
      return sampler({
        event,
        localSeq: context.localSeq,
        installToken,
        sessionToken,
        ...(context.firstOfSession !== undefined ? { firstOfSession: context.firstOfSession } : {}),
        ...(context.outcome !== undefined ? { outcome: context.outcome } : {}),
      })
    },
  }
}
