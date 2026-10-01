// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { sanitizePipelineText } from './sanitize.js'

/**
 * p2-1 (a): the shared sanitizer's escape set is pinned exactly here so the
 * two former private copies (CLI + web) are provably identical to this home.
 * The escape rule: C0 (U+0000–U+001F) and C1 (U+007F–U+009F) each become a
 * four-hex-digit lowercase `\uXXXX`; everything else (including a literal
 * backslash) passes through verbatim.
 */
describe('sanitizePipelineText (shared home)', () => {
  it('escapes EVERY C0 control character as lowercase 4-hex \\uXXXX', () => {
    for (let code = 0x00; code <= 0x1f; code++) {
      const char = String.fromCodePoint(code)
      expect(sanitizePipelineText(char)).toBe(`\\u${code.toString(16).padStart(4, '0')}`)
    }
  })

  it('escapes EVERY C1 control character in U+007F–U+009F', () => {
    for (let code = 0x7f; code <= 0x9f; code++) {
      const char = String.fromCodePoint(code)
      expect(sanitizePipelineText(char)).toBe(`\\u${code.toString(16).padStart(4, '0')}`)
    }
  })

  it('leaves U+0020, U+007E, and non-control text untouched', () => {
    expect(sanitizePipelineText(' ')).toBe(' ')
    expect(sanitizePipelineText('~')).toBe('~')
    expect(sanitizePipelineText('plain id_1 "quoted" \\n literal')).toBe(
      'plain id_1 "quoted" \\n literal',
    )
    expect(sanitizePipelineText('ünï')).toBe('ünï')
  })

  it('keeps escapes inert: a literal backslash-u sequence is byte-stable', () => {
    // Ordinary text (and backslashes) pass through — the produced escapes are
    // inert text, so an authored literal stays exactly as written.
    expect(sanitizePipelineText('\\u001b[31m')).toBe('\\u001b[31m')
    expect(sanitizePipelineText('a\\u0000b')).toBe('a\\u0000b')
  })

  it('escapes a mixed hostile rendering boundary in one pass', () => {
    expect(sanitizePipelineText('\u001b[31mred\u0000\t\u009f')).toBe(
      '\\u001b[31mred\\u0000\\u0009\\u009f',
    )
  })

  it('pads the hex to exactly four lowercase digits', () => {
    // U+000F → \u000f (not \uf, not \u000F).
    expect(sanitizePipelineText('\u000f')).toBe('\\u000f')
    expect(sanitizePipelineText('\u007f')).toBe('\\u007f')
  })
})
