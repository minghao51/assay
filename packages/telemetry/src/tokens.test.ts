// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import {
  generateInstallToken,
  generateSessionToken,
  isHexOfLength,
  isInstallToken,
  isSessionToken,
} from './index.js'

describe('CSPRNG tokens (design §3.1, D9)', () => {
  it('generates install tokens of exactly 32 lowercase hex chars', () => {
    for (let index = 0; index < 64; index++) {
      const token = generateInstallToken()
      expect(token).toMatch(/^[0-9a-f]{32}$/)
      expect(isInstallToken(token)).toBe(true)
    }
  })

  it('generates session tokens of exactly 16 lowercase hex chars', () => {
    for (let index = 0; index < 64; index++) {
      const token = generateSessionToken()
      expect(token).toMatch(/^[0-9a-f]{16}$/)
      expect(isSessionToken(token)).toBe(true)
    }
  })

  it('is not derived from any input: repeated calls are distinct', () => {
    const install = new Set<string>()
    const session = new Set<string>()
    for (let index = 0; index < 200; index++) {
      install.add(generateInstallToken())
      session.add(generateSessionToken())
    }
    expect(install.size).toBe(200)
    expect(session.size).toBe(200)
  })

  it('enforces the exact grammar in the type guards', () => {
    expect(isInstallToken('a'.repeat(32))).toBe(true)
    expect(isInstallToken('A'.repeat(32))).toBe(false)
    expect(isInstallToken('a'.repeat(31))).toBe(false)
    expect(isInstallToken('g'.repeat(32))).toBe(false)
    expect(isInstallToken(12345)).toBe(false)
    expect(isInstallToken(undefined)).toBe(false)

    expect(isSessionToken('a'.repeat(16))).toBe(true)
    expect(isSessionToken('a'.repeat(15))).toBe(false)
    expect(isSessionToken('ab cd'.padEnd(16, '0'))).toBe(false)
    expect(isSessionToken(null)).toBe(false)
  })

  it('isHexOfLength is total and exact', () => {
    expect(isHexOfLength('', 0)).toBe(true)
    expect(isHexOfLength('00', 2)).toBe(true)
    expect(isHexOfLength('0', 2)).toBe(false)
    expect(isHexOfLength('zz', 2)).toBe(false)
    expect(isHexOfLength(5, 1)).toBe(false)
  })
})
