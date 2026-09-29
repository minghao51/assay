// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { quoteIdentifier } from '@assay/validation'
import { quotePortIdentifier } from './identifiers.js'

const HOSTILE_NAMES = [
  'customers',
  'customer_id',
  'a b',
  'a"b',
  "a'b",
  'a;b',
  'a--b',
  'ünï',
  '1',
  '__proto__',
  'select',
  'a\nb',
  'a\\b',
  '',
]

describe('quotePortIdentifier', () => {
  for (const name of HOSTILE_NAMES) {
    it(`renders ${JSON.stringify(name)} exactly like @assay/validation`, () => {
      expect(quotePortIdentifier(name)).toBe(quoteIdentifier(name))
    })
  }

  it('double-quotes and escapes embedded quotes', () => {
    expect(quotePortIdentifier('weird "quoted" key')).toBe('"weird ""quoted"" key"')
  })
})
