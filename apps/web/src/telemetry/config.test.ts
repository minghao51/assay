// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { parseAppVersion, readBuildChannel, readWebTelemetryConfig } from './config'

describe('web telemetry config', () => {
  it('parses and clamps a semver into bounded integers', () => {
    expect(parseAppVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 })
    expect(parseAppVersion('1000.2000.10000')).toEqual({ major: 999, minor: 999, patch: 9999 })
    expect(parseAppVersion('not-a-version')).toEqual({ major: 0, minor: 0, patch: 0 })
  })

  it('maps the Vite mode flags to the closed build channel', () => {
    expect(readBuildChannel({ DEV: true })).toBe('dev')
    expect(readBuildChannel({ PROD: true })).toBe('release')
    expect(readBuildChannel({})).toBe('unknown')
  })

  it('is inert in the test/stock build: no endpoint and no hard off', () => {
    const config = readWebTelemetryConfig()
    expect(config.endpoint).toBe('')
    expect(config.hardOff).toBe(false)
  })
})
