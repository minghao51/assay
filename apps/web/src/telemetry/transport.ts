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
 *
 * Opt-out cancellation (E01 option A, design
 * `20261120-e01-optout-cancellation-design.md` §3.1/§3.3): `send` takes an
 * optional `{ signal }`. A caller abort is a **drop**, not a failure: it is
 * checked before every attempt and after the backoff, it aborts the in-flight
 * attempt, and it is never confused with the per-attempt timeout (which stays
 * retryable). Transports that ignore the parameter keep today's behavior; the
 * runtime cannot stop a retry loop it does not own (design §5).
 */
import type { TelemetryEvent } from '@assay/telemetry'

/** Optional per-send cancellation (E01 option A). */
export interface TelemetrySendOptions {
  /** The runtime's generation signal; aborting it drops the batch. */
  readonly signal?: AbortSignal
}

/**
 * One transport batch delivery. Must never reject in production. The options
 * parameter is **optional** on purpose: every existing one-argument transport
 * (including the test fakes) stays assignable and behaves as today, and a
 * transport that accepts it contracts to honor `signal`.
 */
export interface TelemetryTransport {
  send(batch: readonly TelemetryEvent[], options?: TelemetrySendOptions): Promise<void>
}

/**
 * Injectable clock/sleep so transport tests never wait on a real timer. The
 * optional `signal` is how the **preferred** early exit works (E01 §3.3): a
 * sleep that honors it settles as soon as the caller aborts, so no attempt
 * timer survives the opt-out. A sleep that ignores it still leaves the
 * post-backoff check guaranteeing no further fetch starts.
 */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>

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

/**
 * One attempt's verdict. `retry` is the only outcome the bounded retry policy
 * may act on; `cancelled` is a caller opt-out, which is a drop.
 */
type AttemptOutcome = 'sent' | 'retry' | 'drop' | 'cancelled'

interface AttemptSenderContext {
  readonly endpoint: string
  readonly timeoutMs: number
  readonly fetchImpl: typeof fetch
}

interface AttemptInput {
  readonly body: string
  readonly headers: Record<string, string>
  readonly caller: AbortSignal | undefined
}

/**
 * POST one attempt and classify it (E01 §3.3). The per-attempt timeout keeps
 * its own controller + timer, so a timeout stays a **retryable** failure; a
 * caller abort is reported as `cancelled` (drop) and never as `retry`. The
 * attempt timer and the caller-signal listener are both removed in `finally`,
 * so repeated sends never accumulate listeners on the generation signal.
 */
function createAttemptSender(
  context: AttemptSenderContext,
): (input: AttemptInput) => Promise<AttemptOutcome> {
  const { endpoint, timeoutMs, fetchImpl } = context
  return async ({ body, headers, caller }: AttemptInput): Promise<AttemptOutcome> => {
    const controller = new AbortController()
    let cancelled = false
    const onCallerAbort = (): void => {
      cancelled = true
      controller.abort()
    }
    const timer = setTimeout(() => {
      controller.abort()
    }, timeoutMs)
    caller?.addEventListener('abort', onCallerAbort, { once: true })
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
        // Let an exit-time flush complete even if navigation continues.
        keepalive: true,
      })
      if (cancelled) return 'cancelled'
      if (response.ok) return 'sent'
      // 4xx: drop without retry; 5xx: bounded retry then drop.
      return response.status >= 500 ? 'retry' : 'drop'
    } catch {
      // Network error / timeout abort: retryable — unless the caller aborted,
      // which is a drop (never retried, never re-slept).
      return cancelled ? 'cancelled' : 'retry'
    } finally {
      clearTimeout(timer)
      caller?.removeEventListener('abort', onCallerAbort)
    }
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve()
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Backoff that settles early on a caller abort (E01 §3.3, preferred form).
 * Returns `false` when the wait was cut short. The `sleep` seam is given the
 * signal (the default honors it); the race is the belt-and-braces half so a
 * seam that ignores the signal cannot hold the abort, and the abort listener is
 * always removed before this resolves.
 */
async function sleepUnlessAborted(
  sleep: Sleep,
  ms: number,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  if (signal === undefined) {
    await sleep(ms)
    return true
  }
  if (signal.aborted) return false
  const slept = sleep(ms, signal).then(
    () => true,
    () => true,
  )
  let onAbort: (() => void) | null = null
  const aborted = new Promise<boolean>((resolve) => {
    onAbort = (): void => {
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([slept, aborted])
  } finally {
    if (onAbort !== null) signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Create the default HTTP transport. Construct only after the endpoint gate
 * has accepted `endpoint` (design §8.1/R6).
 */
export function createFetchTransport(options: FetchTransportOptions): TelemetryTransport {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const retries = options.retries ?? DEFAULT_RETRIES
  const sleep = options.sleep ?? defaultSleep
  const attempt = createAttemptSender({
    endpoint: options.endpoint,
    timeoutMs,
    fetchImpl: options.fetchImpl ?? globalThis.fetch.bind(globalThis),
  })
  return {
    async send(
      batch: readonly TelemetryEvent[],
      sendOptions?: TelemetrySendOptions,
    ): Promise<void> {
      if (batch.length === 0) return
      const caller = sendOptions?.signal
      // A caller that already gave up starts nothing at all. Read through a
      // closure so each check re-reads the live value (a `const` reference to a
      // narrowed `aborted` would be judged unreachable by the type checker).
      const callerAborted = (): boolean => caller?.aborted === true
      if (callerAborted()) return
      const body = JSON.stringify(batch)
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (options.token !== undefined && options.token !== '') {
        headers['authorization'] = `Bearer ${options.token}`
      }
      for (let index = 0; index <= retries; index++) {
        // Cancel check #1: before each attempt (E01 §3.3) — no fetch after an
        // opt-out, however the previous attempt ended.
        if (callerAborted()) return
        const outcome = await attempt({ body, headers, caller })
        if (outcome !== 'retry') return
        if (index === retries) return
        const slept = await sleepUnlessAborted(sleep, BACKOFF_BASE_MS * 2 ** index, caller)
        // Cancel check #2: after the backoff (E01 §3.3). The loop-head check
        // would also stop the next fetch; this keeps the drop explicit and
        // independent of how the injected backoff behaves.
        if (!slept || callerAborted()) return
      }
    },
  }
}
