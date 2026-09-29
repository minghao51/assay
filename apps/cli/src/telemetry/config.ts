// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * CLI telemetry configuration sources (design §6.1/§6.2/§8.1).
 *
 * The kill switch is `ASSAY_NO_TELEMETRY` with the one-release
 * `DATAWORKBENCH_NO_TELEMETRY` alias; any defined, non-empty value disables —
 * including `0` and `false` (fail-safe: setting the variable at all expresses
 * intent). Only an unset/empty variable leaves telemetry enabled.
 *
 * The endpoint/token come from `ASSAY_TELEMETRY_ENDPOINT` /
 * `ASSAY_TELEMETRY_TOKEN`; unset/empty means inert (R6). The persisted
 * preference + disclosure-shown marker live in a small JSON file under the
 * platform config dir (or `ASSAY_CONFIG_DIR` for tests).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The environment shape the telemetry glue reads (injectable for tests). */
export type CliEnv = Readonly<Record<string, string | undefined>>

/** The persisted CLI telemetry preference. */
export type CliTelemetryPreference = 'on' | 'off'

/** The persisted config file shape. */
export interface CliTelemetryConfigFile {
  readonly preference?: CliTelemetryPreference
  readonly disclosureShown?: boolean
  /** The 128-bit install pseudonym, persisted across runs. */
  readonly installToken?: string
}

/** Canonical kill switch (design §6.1). */
export const NO_TELEMETRY_VAR = 'ASSAY_NO_TELEMETRY'
/** Transition alias, accepted this release (OQ7). */
export const NO_TELEMETRY_ALIAS = 'DATAWORKBENCH_NO_TELEMETRY'

/** True when either kill switch is defined and non-empty (fail-safe). */
export function isEnvNoTelemetry(env: CliEnv): boolean {
  return [NO_TELEMETRY_VAR, NO_TELEMETRY_ALIAS].some((name) => {
    const value = env[name]
    return value !== undefined && value !== ''
  })
}

/** The configured collector endpoint (empty when unset). */
export function readEndpoint(env: CliEnv): string {
  return env['ASSAY_TELEMETRY_ENDPOINT'] ?? ''
}

/** The optional write-only ingest token (empty when unset). */
export function readToken(env: CliEnv): string {
  return env['ASSAY_TELEMETRY_TOKEN'] ?? ''
}

/** The config directory: `ASSAY_CONFIG_DIR` override, else XDG/HOME. */
export function configDir(env: CliEnv): string {
  const override = env['ASSAY_CONFIG_DIR']
  if (override !== undefined && override !== '') return override
  const xdg = env['XDG_CONFIG_HOME']
  if (xdg !== undefined && xdg !== '') return join(xdg, 'assay')
  const home = env['HOME'] ?? ''
  return join(home, '.config', 'assay')
}

/** The config file path. */
export function configFilePath(env: CliEnv): string {
  return join(configDir(env), 'telemetry.json')
}

/** Read the persisted config, tolerating a missing/corrupt file (total). */
export function readConfig(env: CliEnv): CliTelemetryConfigFile {
  try {
    const path = configFilePath(env)
    if (!existsSync(path)) return {}
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return {}
    const record = parsed as Record<string, unknown>
    const result: {
      preference?: CliTelemetryPreference
      disclosureShown?: boolean
      installToken?: string
    } = {}
    if (record['preference'] === 'on' || record['preference'] === 'off') {
      result.preference = record['preference']
    }
    if (typeof record['disclosureShown'] === 'boolean') {
      result.disclosureShown = record['disclosureShown']
    }
    if (typeof record['installToken'] === 'string') {
      result.installToken = record['installToken']
    }
    return result
  } catch {
    return {}
  }
}

/** Merge a patch into the persisted config; a write failure is swallowed. */
export function writeConfig(env: CliEnv, patch: CliTelemetryConfigFile): void {
  try {
    const dir = configDir(env)
    mkdirSync(dir, { recursive: true })
    const next = { ...readConfig(env), ...patch }
    writeFileSync(configFilePath(env), `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  } catch {
    // Unwritable config dir — telemetry stays inert/default; never surface.
  }
}

/**
 * Resolve the effective opt-out (design §6.1 precedence):
 * `ASSAY_NO_TELEMETRY` > `--no-telemetry` > config preference > default on.
 */
export function isOptedOut(
  env: CliEnv,
  flagNoTelemetry: boolean,
  file: CliTelemetryConfigFile = readConfig(env),
): boolean {
  if (isEnvNoTelemetry(env)) return true
  if (flagNoTelemetry) return true
  return file.preference === 'off'
}
