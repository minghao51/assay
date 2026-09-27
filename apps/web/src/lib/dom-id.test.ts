// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { domId, encodeIdText, encodePath, encodePathSegment } from './dom-id'

/**
 * AR-W11 grammar pins (S4). The old `[^A-Za-z0-9_-] → -` mapping was lossy, so
 * distinct dataset-derived names produced duplicate DOM ids/expansion keys.
 * The shared encoder must be injective and stable.
 */

describe('encodeIdText (AR-W11)', () => {
  it('maps distinct texts to distinct encodings', () => {
    const names = ['a.b', 'a-b', 'a b', 'a_b', 'x!y', 'x?y', 'x/y', 'weird "quoted" key']
    const ids = names.map(encodeIdText)
    expect(new Set(ids).size).toBe(names.length)
    expect(encodeIdText('a.b')).not.toBe(encodeIdText('a-b'))
    expect(encodeIdText('a b')).not.toBe(encodeIdText('a_b'))
  })

  it('is stable, hex-only, and total', () => {
    expect(encodeIdText('a.b')).toBe(encodeIdText('a.b'))
    expect(encodeIdText('a.b')).toMatch(/^[0-9a-f-]+$/)
    // A lone surrogate must not throw (names are untrusted text).
    expect(() => encodeIdText('\uD800')).not.toThrow()
  })
})

describe('domId', () => {
  it('prefixes the encoding', () => {
    expect(domId('filter-input', 'a.b')).toBe(`filter-input-${encodeIdText('a.b')}`)
  })
})

describe('encodePathSegment / encodePath (S4 `/` ambiguity)', () => {
  it('passes safe segments through but never lets an encoded one look safe', () => {
    expect(encodePathSegment('deep')).toBe('deep')
    expect(encodePathSegment('a.b')).toBe(`~${encodeIdText('a.b')}`)
    expect(encodePathSegment('x/y')).toBe(`~${encodeIdText('x/y')}`)
    // The `~` marker is outside the safe set, so an encoded segment can never
    // collide with a literal safe segment that happens to look hex-like.
    expect(encodePathSegment(`~${encodeIdText('a.b')}`)).not.toBe(encodePathSegment('a.b'))
    expect(encodePathSegment('a-b')).not.toBe(encodePathSegment('a.b'))
  })

  it('joined paths distinguish a `/` key from real nesting', () => {
    expect(encodePath(['x/y'])).not.toBe(encodePath(['x', 'y']))
    expect(encodePath(['a.b'])).not.toBe(encodePath(['a-b']))
    // `/` is only ever the separator: no single encoded segment contains it.
    expect(encodePath(['x/y'])).not.toContain('/')
    expect(encodePath(['x', 'y'])).toBe('x/y')
  })
})
