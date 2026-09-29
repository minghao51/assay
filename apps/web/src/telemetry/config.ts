// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Build-time telemetry configuration for the web surface (design §6.1/§6.2/§8.1).
 *
 * The collector endpoint/token and the hard off switch are injected by Vite
 * `define` at build time (see `apps/web/vite.config.ts`) from
 * `ASSAY_TELEMETRY_ENDPOINT`, `ASSAY_TELEMETRY_TOKEN`, and `ASSAY_NO_TELEMETRY`.
 * The stock source build leaves all of them unset, so the endpoint is empty and
 * telemetry is inert (R6). The hard off switch has no runtime override
 * (orchestrator decision 3).
 *
 * The `define` identifiers are read through `typeof` guards so the module also
 * runs under Vitest (where they are undeclared): `typeof undeclared` is
 * `'undefined'`, never a throw.
 */
import type { BuildChannel } from '@assay/telemetry'

/** The web surface's resolved build config. */
export interface WebTelemetryBuildConfig {
  /** The collector endpoint; empty when unconfigured (the stock build). */
  readonly endpoint: string
  /** Optional transport-only ingest token; never persisted in events. */
  readonly token: string
  /** Build-time hard off (`ASSAY_NO_TELEMETRY` non-empty) — no override. */
  readonly hardOff: boolean
  /** App version decomposed into the schema's bounded integers. */
  readonly appVersion: { readonly major: number; readonly minor: number; readonly patch: number }
  /** Closed build-channel enum (design §3.2). */
  readonly buildChannel: BuildChannel
}

/** Clamp one version component into its schema bound. */
function clampVersionComponent(raw: string | undefined, max: number): number {
  const value = Number(raw)
  if (!Number.isFinite(value)) return 0
  return Math.min(max, Math.max(0, Math.trunc(value)))
}

/** Parse `major.minor.patch` into the bounded envelope integers (total). */
export function parseAppVersion(raw: string): {
  readonly major: number
  readonly minor: number
  readonly patch: number
} {
  const [major, minor, patch] = raw.split('.')
  return {
    major: clampVersionComponent(major, 999),
    minor: clampVersionComponent(minor, 999),
    patch: clampVersionComponent(patch, 9999),
  }
}

/** The build channel enum from Vite's mode flags. */
export function readBuildChannel(env: {
  readonly DEV?: boolean
  readonly PROD?: boolean
}): BuildChannel {
  if (env.DEV === true) return 'dev'
  if (env.PROD === true) return 'release'
  return 'unknown'
}

/** Read the build-time defines into the resolved config. */
export function readWebTelemetryConfig(): WebTelemetryBuildConfig {
  const endpoint =
    typeof __ASSAY_TELEMETRY_ENDPOINT__ === 'string' ? __ASSAY_TELEMETRY_ENDPOINT__ : ''
  const token = typeof __ASSAY_TELEMETRY_TOKEN__ === 'string' ? __ASSAY_TELEMETRY_TOKEN__ : ''
  const hardOff =
    typeof __ASSAY_TELEMETRY_HARD_OFF__ === 'boolean' ? __ASSAY_TELEMETRY_HARD_OFF__ : false
  const version = typeof __ASSAY_APP_VERSION__ === 'string' ? __ASSAY_APP_VERSION__ : '0.0.0'
  return {
    endpoint,
    token,
    hardOff,
    appVersion: parseAppVersion(version),
    buildChannel: readBuildChannel(import.meta.env),
  }
}
