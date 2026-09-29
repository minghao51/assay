// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The CLI telemetry transport seam (design §8.3, Appendix B). Mirrors the web
 * transport: 2xx accepted; 4xx dropped without retry; 5xx/timeout retried at
 * most twice, then dropped; every failure swallowed (R9). Constructed only
 * after the endpoint gate passes, so the stock build makes zero network calls.
 */
import type { TelemetryEvent } from '@assay/telemetry'

export interface CliTelemetryTransport {
  send(batch: readonly TelemetryEvent[]): Promise<void>
}

export type Sleep = (ms: number) => Promise<void>

export interface CliTransportOptions {
  readonly endpoint: string
  readonly token?: string
  readonly fetchImpl?: typeof fetch
  readonly timeoutMs?: number
  readonly retries?: number
  readonly sleep?: Sleep
}

const DEFAULT_TIMEOUT_MS = 1_500
const DEFAULT_RETRIES = 2
const BACKOFF_BASE_MS = 200

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** Create the HTTP transport; call only when the endpoint gate accepted. */
export function createCliTransport(options: CliTransportOptions): CliTelemetryTransport {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const retries = options.retries ?? DEFAULT_RETRIES
  const sleep = options.sleep ?? defaultSleep
  return {
    async send(batch: readonly TelemetryEvent[]): Promise<void> {
      if (batch.length === 0) return
      const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis)
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (options.token !== undefined && options.token !== '') {
        headers['authorization'] = `Bearer ${options.token}`
      }
      const body = JSON.stringify(batch)
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
            })
            if (response.ok) return
            retryable = response.status >= 500
          } finally {
            clearTimeout(timer)
          }
        } catch {
          retryable = true
        }
        if (!retryable || attempt === retries) return
        await sleep(BACKOFF_BASE_MS * 2 ** attempt)
      }
    },
  }
}
