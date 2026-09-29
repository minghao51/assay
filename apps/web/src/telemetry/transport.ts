// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The web telemetry transport seam (design §8.3, Appendix B).
 *
 * A transport is a single `send(batch)` method. Unit tests inject a fake; the
 * default implementation posts compact JSON to the validated collector
 * endpoint with `fetch`. It is only ever constructed when the endpoint gate is
 * enabled (`createWebTelemetry`), so the stock build never creates one (R6).
 *
 * Failure policy (design §8.3/Appendix B) is owned here so the runtime stays
 * scheduling/opt-out-only: 2xx succeeds; 4xx drops the batch with NO retry (a
 * schema/client bug must not loop); 5xx/timeout retries at most twice with a
 * bounded exponential backoff, then drops. Every failure is swallowed — a
 * hanging or 5xx collector never blocks or surfaces in the app (R9).
 */
import type { TelemetryEvent } from '@assay/telemetry'

/** One transport batch delivery. Must never reject in production. */
export interface TelemetryTransport {
  send(batch: readonly TelemetryEvent[]): Promise<void>
}

/** Injectable clock/sleep so transport tests never wait on a real timer. */
export type Sleep = (ms: number) => Promise<void>

export interface FetchTransportOptions {
  readonly endpoint: string
  /** Optional write-only ingest token, sent as an `Authorization` header. */
  readonly token?: string
  /** `fetch` implementation (tests); defaults to the platform `fetch`. */
  readonly fetchImpl?: typeof fetch
  /** Per-attempt timeout; the abort is swallowed as a drop-or-retry. */
  readonly timeoutMs?: number
  /** Bounded retry count for 5xx/timeout (design §8.3: at most 2). */
  readonly retries?: number
  /** Backoff sleep (tests inject a no-op). */
  readonly sleep?: Sleep
}

const DEFAULT_TIMEOUT_MS = 5_000
const DEFAULT_RETRIES = 2
const BACKOFF_BASE_MS = 250

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * Create the default HTTP transport. Construct only after the endpoint gate
 * has accepted `endpoint` (design §8.1/R6).
 */
export function createFetchTransport(options: FetchTransportOptions): TelemetryTransport {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const retries = options.retries ?? DEFAULT_RETRIES
  const sleep = options.sleep ?? defaultSleep
  return {
    async send(batch: readonly TelemetryEvent[]): Promise<void> {
      if (batch.length === 0) return
      const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
      const body = JSON.stringify(batch)
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (options.token !== undefined && options.token !== '') {
        headers['authorization'] = `Bearer ${options.token}`
      }
      for (let attempt = 0; attempt <= retries; attempt++) {
        let retryable = false
        try {
          const controller = new AbortController()
          const timer = setTimeout(() => {
            controller.abort()
          }, timeoutMs)
          try {
            const response = await fetchImpl(options.endpoint, {
              method: 'POST',
              headers,
              body,
              signal: controller.signal,
              // Let an exit-time flush complete even if navigation continues.
              keepalive: true,
            })
            if (response.ok) return
            // 4xx: drop without retry; 5xx: bounded retry then drop.
            retryable = response.status >= 500
          } finally {
            clearTimeout(timer)
          }
        } catch {
          // Network error / timeout abort: treat as retryable.
          retryable = true
        }
        if (!retryable || attempt === retries) return
        await sleep(BACKOFF_BASE_MS * 2 ** attempt)
      }
    },
  }
}
