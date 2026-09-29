// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The CLI telemetry runtime (design §5.2/§6/§8.3) — the app-layer glue around
 * the pure core, mirroring the web runtime's behavior with a process lifecycle:
 *
 * - resolves env/config precedence, endpoint gate, and the optional transport;
 * - mints/persists the install token and a per-process session token;
 * - runs sampling before construction, validates/buffers events, and enforces
 *   the §5.2 caps and the 50-per-session `dataset_opened` cap;
 * - shows the §6.3 disclosure to **stderr only**, once per install, before the
 *   first send; emits `disclosure_shown` accordingly;
 * - re-reads the opt-out on every send (§6.4), clears the buffer synchronously
 *   on opt-out (§6.5), clamps `client_day` (§6.6), and swallows every failure
 *   (R9). The exit flush is bounded (design §8.3).
 *
 * The default transport is built only when the endpoint gate passes, so a
 * stock build constructs nothing and sends nothing (R6).
 */
import {
  CLI_DISCLOSURE_COPY,
  DISCLOSURE_REVISION,
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
  BuildChannel,
  EventName,
  InstallToken,
  OpenFailureReason,
  SessionToken,
  TelemetryOutcome,
  TelemetryPayload,
} from '@assay/telemetry'
import { readCliVersion } from '../version.js'
import {
  isEnvNoTelemetry,
  isOptedOut,
  readConfig,
  readEndpoint,
  readToken,
  writeConfig,
} from './config'
import type { CliEnv } from './config'
import { createCliTransport } from './transport'
import type { CliTelemetryTransport } from './transport'
import { osFamilyFromPlatform, reasonFromCliError as reasonFromError } from './emit'

const DAY_MS = 86_400_000
const CLIENT_DAY_MIN = 19_000
const CLIENT_DAY_MAX = 40_000
const EXIT_FLUSH_BUDGET_MS = 750

/** Clamp a millisecond timestamp to the schema's `client_day` bound (§6.6). */
export function clampClientDay(now: number): number {
  const day = Math.floor(now / DAY_MS)
  return Math.min(CLIENT_DAY_MAX, Math.max(CLIENT_DAY_MIN, day))
}

/** Parse a semver into the bounded envelope integers (total). */
export function parseVersion(raw: string): { major: number; minor: number; patch: number } {
  const clamp = (value: string | undefined, max: number): number => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return 0
    return Math.min(max, Math.max(0, Math.trunc(parsed)))
  }
  const [major, minor, patch] = raw.split('.')
  return { major: clamp(major, 999), minor: clamp(minor, 999), patch: clamp(patch, 9999) }
}

/** The build channel from the CLI environment (closed enum, design §3.2). */
export function buildChannelFromEnv(env: CliEnv): BuildChannel {
  const nodeEnv = env['NODE_ENV']
  if (env['CI'] !== undefined && env['CI'] !== '' && env['CI'] !== 'false') return 'ci'
  if (nodeEnv === 'development') return 'dev'
  return 'release'
}

/** The injected inputs for {@link createCliTelemetry}. */
export interface CliTelemetryOptions {
  readonly env: CliEnv
  /** The parsed `--no-telemetry` flag for this invocation. */
  readonly flagNoTelemetry: boolean
  readonly stderr: { write(chunk: string): unknown }
  /** Transport override (tests). */
  readonly transport?: CliTelemetryTransport | null
  readonly now?: () => number
  readonly sessionToken?: SessionToken
  readonly version?: string
  readonly platform?: string
}

/** The lifecycle surface consumed by `main` and the command runners. */
export interface CliTelemetry {
  /** True when an endpoint is configured and the env kill switch is absent. */
  readonly active: boolean
  /** Show the first-run disclosure (stderr) if pending, then emit `app_boot`. */
  start(): void
  emit<K extends EventName>(
    event: K,
    payload: TelemetryPayload[K],
    outcome?: TelemetryOutcome,
  ): void
  /** Bounded exit flush; failures are swallowed and never delay past budget. */
  flush(budgetMs?: number): Promise<void>
  /** Classify an open failure (re-exported for the command runners). */
  reasonFromError(error: unknown): OpenFailureReason
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** Create the CLI runtime for one invocation. */
export function createCliTelemetry(options: CliTelemetryOptions): CliTelemetry {
  const { env, flagNoTelemetry, stderr } = options
  const now = options.now ?? Date.now
  const endpoint = readEndpoint(env)
  const active = !isEnvNoTelemetry(env) && isTelemetryEnabled(endpoint)
  const version = parseVersion(options.version ?? readCliVersion())
  const buffer = createEventBuffer()
  const session = createSessionTracker()
  const pending: Promise<void>[] = []

  const installToken = (): InstallToken => {
    const persisted = readConfig(env).installToken
    if (persisted !== undefined && isInstallToken(persisted)) return persisted
    const minted = generateInstallToken()
    writeConfig(env, { installToken: minted })
    return minted
  }

  const sessionTokenValue: SessionToken | null =
    options.sessionToken !== undefined && isSessionToken(options.sessionToken)
      ? options.sessionToken
      : active
        ? mintSessionToken()
        : null

  const core =
    active && sessionTokenValue !== null
      ? createTelemetryCore({
          endpoint,
          installToken,
          sessionToken: sessionTokenValue,
        })
      : null

  const transport: CliTelemetryTransport | null =
    options.transport !== undefined
      ? options.transport
      : active
        ? createCliTransport({ endpoint, token: readToken(env) })
        : null

  const shouldSend = (): boolean => {
    if (!active) {
      buffer.clear()
      return false
    }
    if (isOptedOut(env, flagNoTelemetry)) {
      buffer.clear()
      return false
    }
    return true
  }

  const emit = <K extends EventName>(
    event: K,
    payload: TelemetryPayload[K],
    outcome?: TelemetryOutcome,
  ): void => {
    const task = (async () => {
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
        if (!shouldSend()) return
        const built: Record<string, unknown> = {
          schema_version: SCHEMA_VERSION,
          event,
          surface: 'cli',
          install_token: installToken(),
          session_token: sessionTokenValue,
          client_day: clampClientDay(now()),
          app_version_major: version.major,
          app_version_minor: version.minor,
          app_version_patch: version.patch,
          ...payload,
        }
        const validated = validateEvent(built)
        if (!validated.ok) return
        buffer.add(validated.value)
      } catch {
        // R9: never surface a telemetry failure.
      }
    })()
    pending.push(task)
  }

  const flush = async (budgetMs: number = EXIT_FLUSH_BUDGET_MS): Promise<void> => {
    try {
      await Promise.all(pending)
      pending.length = 0
      if (!shouldSend()) {
        buffer.clear()
        return
      }
      if (buffer.size === 0) return
      const events = buffer.drain()
      if (transport === null) return
      const send = (async () => {
        for (const batch of splitIntoBatches(events)) {
          try {
            await transport.send(batch)
          } catch {
            // drop the batch, never surface
          }
        }
      })()
      await Promise.race([send, defaultSleep(budgetMs)])
    } catch {
      // R9: flush never throws.
    }
  }

  const start = (): void => {
    if (!active) return
    const config = readConfig(env)
    if (!isOptedOut(env, flagNoTelemetry, config) && config.disclosureShown !== true) {
      stderr.write(`${CLI_DISCLOSURE_COPY}\n`)
      writeConfig(env, { disclosureShown: true })
      emit('disclosure_shown', { disclosure_revision: DISCLOSURE_REVISION })
    }
    emit('app_boot', {
      engine_family: 'duckdb_node',
      os_family: osFamilyFromPlatform(options.platform ?? process.platform),
      build_channel: buildChannelFromEnv(env),
    })
  }

  return {
    active,
    start,
    emit,
    flush,
    reasonFromError: (error) => reasonFromError(error),
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
