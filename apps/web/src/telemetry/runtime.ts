// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The web telemetry runtime — the app-layer glue around the pure core
 * (design §5.2/§6/§8.3).
 *
 * Responsibilities (all deliberately OUTSIDE `@assay/telemetry`, which stays
 * timer/network/storage-free):
 *
 * - resolve the build config + preference, and gate on endpoint + opt-out;
 * - lazily generate/persist the install token and mint a per-page session token;
 * - run the pure sampling decision (`createTelemetryCore.shouldEmit`) before
 *   constructing anything, then validate/build the event and buffer it;
 * - enforce the §5.2 caps and the 50-per-session `dataset_opened` cap via the
 *   pure `EventBuffer`/`SessionTracker`;
 * - schedule bounded, fire-and-forget flushes through the injected transport;
 * - re-read the preference on EVERY send (§6.4), clear the buffer synchronously
 *   on mid-session opt-out (§6.5), clamp `client_day` (§6.6);
 * - own one abort generation per send (E01 §3.2): `setPreference('off')` and
 *   `dispose()` abort the in-flight delivery, and sending resumes on a fresh
 *   controller so an aborted batch is dropped, never re-sent;
 * - never throw, never block, never surface an error (R9).
 *
 * The default transport is constructed only when the endpoint gate passes; the
 * stock build therefore has no transport, no timer, and no network (R6).
 */
import {
  SCHEMA_VERSION,
  createEventBuffer,
  createSessionTracker,
  createTelemetryCore,
  generateInstallToken,
  generateSessionToken,
  isInstallToken,
  isSessionToken,
  isTelemetryEnabled,
  splitIntoBatches,
  validateEvent,
} from '@assay/telemetry'
import type {
  EventName,
  InstallToken,
  SessionToken,
  Surface,
  TelemetryOutcome,
  TelemetryPayload,
} from '@assay/telemetry'
import type { WebTelemetryBuildConfig } from './config'
import {
  readDisclosureShown,
  readInstallToken,
  readPreference,
  writeDisclosureShown,
  writeInstallToken,
  writePreference,
} from './prefs'
import type { StorageLike, TelemetryPreference } from './prefs'
import { createFetchTransport } from './transport'
import type { TelemetryTransport } from './transport'

/** Days-ms constant for the `client_day` conversion. */
const DAY_MS = 86_400_000

/** §3.1 `client_day` bounds (design §6.6). */
export const CLIENT_DAY_MIN = 19_000
export const CLIENT_DAY_MAX = 40_000

/** Default debounce before a scheduled flush (fire-and-forget). */
export const DEFAULT_FLUSH_DELAY_MS = 2_000

/** Clamp a `Date.now()`-style millisecond timestamp to the schema bound. */
export function clampClientDay(now: number): number {
  const day = Math.floor(now / DAY_MS)
  return Math.min(CLIENT_DAY_MAX, Math.max(CLIENT_DAY_MIN, day))
}

/**
 * The scheduling-seam handle a default timer returns, deliberately opaque to
 * the runtime: it is only ever handed back to the paired {@link CancelFlush}
 * seam, never interpreted. The seam itself accepts any test handle.
 */
type FlushHandle = ReturnType<typeof setTimeout>

/** Scheduling seam: returns a handle the runtime can later clear. */
export type ScheduleFlush = (task: () => void, delayMs: number) => unknown
/** Clear seam paired with {@link ScheduleFlush}. */
export type CancelFlush = (handle: unknown) => void

export interface WebTelemetryOptions {
  readonly config: WebTelemetryBuildConfig
  readonly storage: StorageLike | null
  /** Transport override (tests). When omitted, one is built from the config. */
  readonly transport?: TelemetryTransport | null
  /** Clock seam (tests). Defaults to `Date.now`. */
  readonly now?: () => number
  /** Scheduling seam (tests). Defaults to `setTimeout`/`clearTimeout`. */
  readonly scheduleFlush?: ScheduleFlush
  readonly cancelFlush?: CancelFlush
  readonly flushDelayMs?: number
  /** Session token override (tests); otherwise minted from the CSPRNG. */
  readonly sessionToken?: SessionToken
}

/** The runtime the app and its components consume. */
export interface WebTelemetryRuntime {
  readonly surface: Surface
  /** True when `ASSAY_NO_TELEMETRY` was set at build time (no override). */
  readonly hardOff: boolean
  /** True when a valid collector endpoint was configured at build time. */
  readonly endpointConfigured: boolean
  /**
   * Buffer one event after the §6.4 check + §5 sampling decision. Fire and
   * forget: returns immediately, never throws, never surfaces an error.
   */
  emit<K extends EventName>(
    event: K,
    payload: TelemetryPayload[K],
    outcome?: TelemetryOutcome,
  ): void
  /** Deliver everything buffered (best effort; failures swallowed). */
  flush(): Promise<void>
  /** The current persisted preference. */
  getPreference(): TelemetryPreference
  /** Persist the preference; `'off'` clears the buffer synchronously (§6.5). */
  setPreference(preference: TelemetryPreference): void
  /** The §6.4 "would send right now" gate (endpoint + preference + hard-off). */
  isEnabledNow(): boolean
  /** Whether the first-run disclosure must be shown before the first send. */
  shouldShowDisclosure(): boolean
  /** Record that the disclosure was rendered (unblocks flushing). */
  markDisclosureShown(): void
  /** Cancel any pending flush timer. */
  dispose(): void
}

/** The `localStorage` handle, or `null` when storage is unavailable. */
export function browserStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function defaultSchedule(task: () => void, delayMs: number): FlushHandle {
  return setTimeout(task, delayMs)
}

function defaultCancel(handle: unknown): void {
  clearTimeout(handle as FlushHandle)
}

/**
 * Create the web runtime. The returned object is inert (no transport, no
 * buffer growth, no timer) whenever the endpoint is unconfigured/invalid or
 * the build-time hard off is set.
 */
export function createWebTelemetry(options: WebTelemetryOptions): WebTelemetryRuntime {
  const { config, storage } = options
  const now = options.now ?? Date.now
  const schedule = options.scheduleFlush ?? defaultSchedule
  const cancel = options.cancelFlush ?? defaultCancel
  const flushDelayMs = options.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS
  const endpointValid = !config.hardOff && isTelemetryEnabled(config.endpoint)
  const buffer = createEventBuffer()
  const session = createSessionTracker()

  let timer: unknown = null
  /**
   * §6.5 fallback: a mid-session `setPreference('off')` must stick even when
   * `localStorage.setItem` throws. The in-memory preference is authoritative
   * for this page once set; before that, storage is re-read on every send
   * (§6.4).
   */
  let memoryPreference: TelemetryPreference | null = null
  /**
   * §6.3 fallback: the disclosure is considered shown for this page even when
   * the persistence write fails, so a storage-less environment can still send
   * after the user has actually seen it.
   */
  let disclosureShownInMemory = false
  /**
   * E01 §3.2: one `AbortController` per send generation. Created lazily when a
   * send starts, aborted by `setPreference('off')`/`dispose()`, and **replaced**
   * (never reused) when sending resumes — so a batch drained before an opt-out
   * is dropped and can never be re-sent or re-slept after off→on.
   */
  let generation: AbortController | null = null

  /** Abort the active generation, if any; the next send starts a fresh one. */
  const abortGeneration = (): void => {
    if (generation !== null && !generation.signal.aborted) generation.abort()
  }

  /**
   * The generation a send belongs to: a live one is reused (two overlapping
   * `flush()` calls share an opt-out), an aborted one is replaced.
   */
  const beginGeneration = (): AbortSignal => {
    if (generation === null || generation.signal.aborted) {
      generation = new AbortController()
    }
    return generation.signal
  }

  const installToken = (): InstallToken => {
    const persisted = readInstallToken(storage)
    if (persisted !== null && isInstallToken(persisted)) return persisted
    const minted = generateInstallToken()
    writeInstallToken(storage, minted)
    return minted
  }

  const sessionTokenValue: SessionToken | null =
    options.sessionToken !== undefined && isSessionToken(options.sessionToken)
      ? options.sessionToken
      : endpointValid
        ? mintSessionToken()
        : null

  const core =
    endpointValid && sessionTokenValue !== null
      ? createTelemetryCore({
          endpoint: config.endpoint,
          installToken,
          sessionToken: sessionTokenValue,
        })
      : null

  const transport: TelemetryTransport | null =
    options.transport !== undefined
      ? options.transport
      : endpointValid
        ? createFetchTransport({ endpoint: config.endpoint, token: config.token })
        : null

  /** §6.4: the in-memory preference (if set this page) wins over storage. */
  const currentPreference = (): TelemetryPreference => memoryPreference ?? readPreference(storage)

  /** §6.4: re-read the preference every call; hard-off and endpoint first. */
  const isEnabledNow = (): boolean => {
    if (config.hardOff) return false
    if (!endpointValid) return false
    return currentPreference() !== 'off'
  }

  /** Check-before-send with the §6.5 synchronous buffer clear on opt-out. */
  const shouldSend = (): boolean => {
    if (!isEnabledNow()) {
      buffer.clear()
      return false
    }
    return true
  }

  const clearTimer = (): void => {
    if (timer !== null) {
      cancel(timer)
      timer = null
    }
  }

  const scheduleFlush = (): void => {
    // Never send before the first-run disclosure has been shown (§6.3).
    if (shouldShowDisclosure()) return
    if (timer !== null) return
    timer = schedule(() => {
      timer = null
      void flush()
    }, flushDelayMs)
  }

  const flush = async (): Promise<void> => {
    try {
      clearTimer()
      // §6.3: no physical send before the first-run disclosure has been shown.
      // Keep the buffer (do not clear) so a later `markDisclosureShown` in the
      // same page can still flush it.
      if (shouldShowDisclosure()) return
      if (!shouldSend()) {
        buffer.clear()
        return
      }
      if (buffer.size === 0) return
      const events = buffer.drain()
      if (transport === null) return
      // The whole drain belongs to one generation: an opt-out mid-loop aborts
      // the signal, so no later batch (or retry) may start.
      const signal = beginGeneration()
      for (const batch of splitIntoBatches(events)) {
        // Between-batch guard (E01 §3.2). At default caps this loop runs once
        // (`MAX_BUFFERED_*` == `MAX_BATCH_*`), so this is future-proofing, not a
        // second observable batch.
        if (signal.aborted) return
        try {
          await transport.send(batch, { signal })
        } catch {
          // R9: a failed batch is dropped, never surfaced.
        }
      }
    } catch {
      // R9: telemetry never throws out of flush.
    }
  }

  const shouldShowDisclosure = (): boolean =>
    isEnabledNow() && !disclosureShownInMemory && !readDisclosureShown(storage)

  const emit = <K extends EventName>(
    event: K,
    payload: TelemetryPayload[K],
    outcome?: TelemetryOutcome,
  ): void => {
    // Fire-and-forget; the async tail swallows every failure (R9).
    void (async () => {
      try {
        if (!shouldSend()) return
        if (core === null || transport === null) return
        if (event === 'dataset_opened' && !session.noteDatasetOpened()) return
        const localSeq = session.nextSeq()
        const firstOfSession = event === 'query_run' ? session.firstQueryOfSession() : undefined
        const sampled = await core.shouldEmit(event, {
          localSeq,
          ...(firstOfSession === true ? { firstOfSession: true } : {}),
          ...(outcome !== undefined ? { outcome } : {}),
        })
        if (!sampled) return
        // Re-check after the await (the preference may have flipped mid-flight).
        if (!shouldSend()) return
        const built: Record<string, unknown> = {
          schema_version: SCHEMA_VERSION,
          event,
          surface: 'web',
          install_token: installToken(),
          session_token: sessionTokenValue,
          client_day: clampClientDay(now()),
          app_version_major: config.appVersion.major,
          app_version_minor: config.appVersion.minor,
          app_version_patch: config.appVersion.patch,
          ...payload,
        }
        const validated = validateEvent(built)
        if (!validated.ok) return
        buffer.add(validated.value)
        scheduleFlush()
      } catch {
        // A WebCrypto-absent rejection or any other failure never propagates.
      }
    })()
  }

  return {
    surface: 'web',
    hardOff: config.hardOff,
    endpointConfigured: endpointValid,
    emit,
    flush,
    getPreference: () => currentPreference(),
    setPreference: (preference: TelemetryPreference): void => {
      // §6.5: the in-memory preference is authoritative this page, so a
      // storage write failure can never silently keep telemetry on.
      memoryPreference = preference
      writePreference(storage, preference)
      if (preference === 'off') {
        buffer.clear()
        // E01 §3.2: stop the delivery already in flight. The batch was drained
        // before this point, so it is dropped, never re-queued; a later
        // off→on sends only newly emitted events.
        abortGeneration()
      }
    },
    isEnabledNow,
    shouldShowDisclosure,
    markDisclosureShown: (): void => {
      disclosureShownInMemory = true
      writeDisclosureShown(storage)
      // The disclosure is now shown; a pending buffer may flush.
      scheduleFlush()
    },
    dispose: (): void => {
      // Existing timer cleanup, plus the E01 §3.2 in-flight abort so a
      // disposed runtime cannot keep delivering.
      clearTimer()
      abortGeneration()
    },
  }
}

/** Mint a session token, tolerating a WebCrypto-absent environment. */
function mintSessionToken(): SessionToken | null {
  try {
    return generateSessionToken()
  } catch {
    return null
  }
}
