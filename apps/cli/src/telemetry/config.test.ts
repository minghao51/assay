// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  configDir,
  configFilePath,
  isEnvNoTelemetry,
  isOptedOut,
  readConfig,
  readEndpoint,
  readToken,
  writeConfig,
} from './config'

const tempDirs: string[] = []

function tempEnv(): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'assay-t2-'))
  tempDirs.push(dir)
  return { ASSAY_CONFIG_DIR: dir }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('CLI telemetry config — kill switch + precedence (design §6.1)', () => {
  it('disables for any defined non-empty value, including 0/false', () => {
    expect(isEnvNoTelemetry({})).toBe(false)
    expect(isEnvNoTelemetry({ ASSAY_NO_TELEMETRY: '' })).toBe(false)
    expect(isEnvNoTelemetry({ ASSAY_NO_TELEMETRY: '0' })).toBe(true)
    expect(isEnvNoTelemetry({ ASSAY_NO_TELEMETRY: 'false' })).toBe(true)
    expect(isEnvNoTelemetry({ ASSAY_NO_TELEMETRY: '1' })).toBe(true)
  })

  it('accepts the DATAWORKBENCH alias this release (OQ7)', () => {
    expect(isEnvNoTelemetry({ DATAWORKBENCH_NO_TELEMETRY: '1' })).toBe(true)
  })

  it('applies the precedence env > flag > config > default on', () => {
    expect(isOptedOut({}, false, {})).toBe(false)
    expect(isOptedOut({}, false, { preference: 'off' })).toBe(true)
    expect(isOptedOut({ ASSAY_NO_TELEMETRY: '1' }, false, { preference: 'on' })).toBe(true)
    expect(isOptedOut({}, true, { preference: 'on' })).toBe(true)
    expect(isOptedOut({ ASSAY_NO_TELEMETRY: '1' }, true, {})).toBe(true)
  })

  it('reads endpoint/token and defaults them to empty', () => {
    expect(readEndpoint({})).toBe('')
    expect(readToken({})).toBe('')
    expect(readEndpoint({ ASSAY_TELEMETRY_ENDPOINT: 'https://x' })).toBe('https://x')
    expect(readToken({ ASSAY_TELEMETRY_TOKEN: 't' })).toBe('t')
  })

  it('resolves the config dir from override/XDG/HOME', () => {
    expect(configDir({ ASSAY_CONFIG_DIR: '/tmp/x' })).toBe('/tmp/x')
    expect(configDir({ XDG_CONFIG_HOME: '/home/u/.config' })).toBe('/home/u/.config/assay')
    expect(configDir({ HOME: '/home/u' })).toBe('/home/u/.config/assay')
  })

  it('round-trips a persisted config and tolerates a corrupt file', () => {
    const env = tempEnv()
    expect(readConfig(env)).toEqual({})
    writeConfig(env, { preference: 'off', disclosureShown: true, installToken: 'a'.repeat(32) })
    expect(readConfig(env)).toEqual({
      preference: 'off',
      disclosureShown: true,
      installToken: 'a'.repeat(32),
    })
    expect(configFilePath(env)).toBe(join(env['ASSAY_CONFIG_DIR'] as string, 'telemetry.json'))
  })

  it('degrades to empty when the config dir is unwritable', () => {
    const env = tempEnv()
    // Point the config dir at an existing FILE so mkdir/write fail fast.
    const blocker = join(env['ASSAY_CONFIG_DIR'] as string, 'blocker')
    writeFileSync(blocker, 'x')
    const unwritable = { ...env, ASSAY_CONFIG_DIR: blocker }
    expect(() => writeConfig(unwritable, { preference: 'off' })).not.toThrow()
    expect(readConfig(unwritable)).toEqual({})
  })
})
