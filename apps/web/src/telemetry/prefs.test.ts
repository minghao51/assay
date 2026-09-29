// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import {
  readDisclosureShown,
  readInstallToken,
  readPreference,
  writeDisclosureShown,
  writeInstallToken,
  writePreference,
} from './prefs'
import type { StorageLike } from './prefs'

function mapStorage(initial: Record<string, string> = {}): StorageLike {
  const map = { ...initial }
  return {
    getItem: (key) => map[key] ?? null,
    setItem: (key, value) => {
      map[key] = value
    },
  }
}

const throwing: StorageLike = {
  getItem: () => {
    throw new Error('denied')
  },
  setItem: () => {
    throw new Error('denied')
  },
}

describe('telemetry preference persistence (design §6.2)', () => {
  it('defaults to on when absent and honors an explicit off', () => {
    expect(readPreference(mapStorage())).toBe('on')
    expect(readPreference(mapStorage({ 'assay.telemetry': 'off' }))).toBe('off')
    // Anything but the exact 'off' value keeps the default-on stance.
    expect(readPreference(mapStorage({ 'assay.telemetry': 'garbage' }))).toBe('on')
  })

  it('persists the preference', () => {
    const storage = mapStorage()
    writePreference(storage, 'off')
    expect(readPreference(storage)).toBe('off')
  })

  it('persists and reads the disclosure marker', () => {
    const storage = mapStorage()
    expect(readDisclosureShown(storage)).toBe(false)
    writeDisclosureShown(storage)
    expect(readDisclosureShown(storage)).toBe(true)
  })

  it('persists the install token', () => {
    const storage = mapStorage()
    expect(readInstallToken(storage)).toBeNull()
    writeInstallToken(storage, 'a'.repeat(32))
    expect(readInstallToken(storage)).toBe('a'.repeat(32))
  })

  it('degrades safely when storage throws (R9)', () => {
    expect(readPreference(throwing)).toBe('on')
    expect(readDisclosureShown(throwing)).toBe(false)
    expect(readInstallToken(throwing)).toBeNull()
    expect(() => writePreference(throwing, 'off')).not.toThrow()
    expect(() => writeDisclosureShown(throwing)).not.toThrow()
    expect(() => writeInstallToken(throwing, 'x')).not.toThrow()
  })
})
