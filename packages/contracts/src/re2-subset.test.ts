// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { checkRe2SubsetPattern } from './re2-subset'

/**
 * Pins for the conservative RE2-subset filter (m5-5). The filter is a
 * conversion-time gate for JSON Schema `pattern` values — deliberately
 * NARROWER than the binding-time RE2 checker in `@assay/validation` (m5-1),
 * which stays authoritative. See the module doc for the division of labor:
 * refused here → typed unsupported-key at conversion; accepted → carried
 * verbatim and judged at binding time.
 */

/** Assert a pattern is inside the conservative subset. */
function accept(pattern: string): void {
  expect(checkRe2SubsetPattern(pattern)).toEqual({ valid: true })
}

/** Assert a pattern is refused, with the given stable reason fragment. */
function reject(pattern: string, reasonFragment: string): void {
  const result = checkRe2SubsetPattern(pattern)
  expect(result.valid).toBe(false)
  if (!result.valid) expect(result.reason).toContain(reasonFragment)
}

describe('accepted: the documented conservative subset', () => {
  it('accepts literals, operators, and the empty pattern', () => {
    accept('')
    accept('abc')
    accept('ünïcødé — ✓') // literal non-ASCII codepoints (no backslash)
    accept('.')
    accept('^a$')
    accept('a|b')
    accept('a|') // empty branch: valid RE2 (not valid ECMA — RE2 semantics govern, see module doc)
    accept('()')
    accept('a\\|b')
    accept('a\\]b')
    accept('}')
    accept(']')
    accept('a{,5}') // not a quantifier shape → literal brace (RE2's own rule)
  })

  it('accepts groups: plain, non-capturing, ECMA-free flag spellings, and (?P<name>)', () => {
    accept('(a)')
    accept('(a|b)+c?')
    accept('(?:ab)')
    accept('(?i)')
    accept('(?im)')
    accept('(?i)abc')
    accept('(?im:x)')
    accept('(?P<name>a+b)')
    accept('(?P<n_1>x)(?P<a>\\d)')
    accept('(a(b(c))d)')
  })

  it('accepts quantifiers with RE2 limits, lazy forms included', () => {
    accept('a*')
    accept('a+')
    accept('a?')
    accept('a*?')
    accept('a+?')
    accept('a??')
    accept('a{2}')
    accept('a{2,}')
    accept('a{2,4}')
    accept('a{2,4}?')
    accept('a{0,1000}')
    accept('a{1000}')
    // S7: the product of nested repeat counts is bounded at 1000 too.
    accept('(a{40}){25}') // 40 × 25 = 1000
    accept('((a{10}){10}){10}') // 10 × 10 × 10 = 1000
    accept('(a{1000}){1}')
    accept('(a{100}){10,}') // unbounded max contributes its minimum 10
    accept('(a{2}){500}')
  })

  it('accepts character classes: ranges, negation, escaped items, edge dashes', () => {
    accept('[abc]')
    accept('[a-z]+')
    accept('[^a-z]')
    accept('[A-Za-z0-9_]')
    accept('[a\\-z]') // escaped dash: literals a, -, z
    accept('[\\]]')
    accept('[-a]') // leading dash is literal
    accept('[a-]') // trailing dash is literal
    accept('[\\d\\s]')
    accept('[^\\w.]')
    accept('[[]') // '[' is a literal class item (only '[:' is special — refused below)
    accept('[A-F0-9 -]')
    accept('[]a]') // leading ] is a literal member in both dialects (AR-V1)
    accept('[]]')
    accept('[^]a]')
    // au3-10: range endpoints are code points, so an astral range
    // (U+1F600–U+1F604) is ascending — code-unit math would call it reversed.
    accept('[😀-😄]')
  })

  it('accepts the escape whitelist', () => {
    accept('\\d')
    accept('\\D')
    accept('\\s')
    accept('\\S')
    accept('\\w')
    accept('\\W')
    accept('\\b')
    accept('\\B')
    accept('\\bfoo\\b')
    accept('\\n\\t\\r\\f')
    accept('\\v') // vertical tab in both ECMA-262 and RE2 (AR-V1)
    accept('[\\v]')
    accept('\\w+@\\w+\\.com')
    accept('\\{\\}') // escaped ASCII punctuation → literal
    accept('a\\\\b') // escaped backslash
  })

  it('accepts nesting exactly up to the documented depth bound (100)', () => {
    accept(`(${'('.repeat(99)}a${')'.repeat(99)})`)
  })
})

describe('refused: constructs RE2 cannot express (dialect honesty)', () => {
  it('refuses lookarounds, lookbehinds, ECMA named groups, and atomic groups', () => {
    reject('a(?=b)', 'lookaround')
    reject('a(?!b)', 'lookaround')
    reject('(?<=a)b', 'lookbehind')
    reject('(?<!a)b', 'lookbehind')
    reject('(?<name>x)', '(?P<name>')
    reject('(?>a)', 'atomic')
  })

  it('refuses possessive quantifiers', () => {
    reject('a*+', 'possessive')
    reject('a++', 'possessive')
    reject('a?+', 'possessive')
    reject('a{2,4}+', 'possessive')
    reject('a*?+', 'possessive') // lazy then possessive
  })

  it('refuses backreferences and the whole decimal-escape class', () => {
    reject('(a)\\1', '\\0–\\9')
    reject('\\2', '\\0–\\9')
    reject('\\0', '\\0–\\9')
    reject('\\012', '\\0–\\9')
  })

  it('refuses escapes whose ECMA-262 and RE2 readings diverge, and RE2-absent escapes', () => {
    reject('\\A', 'anchor')
    reject('\\z', 'anchor')
    reject('\\a', 'bell')
    reject('\\cA', 'control escape')
    reject('\\u0041', 'RE2 has no \\u escape')
    reject('\\u{41}', 'RE2 has no')
    reject('\\p{L}', 'Unicode property')
    reject('\\P{L}', 'Unicode property')
    reject('\\Qa+b\\E', 'quoting')
    reject('\\E', 'quoting')
    reject('\\Z', 'not RE2')
    reject('\\K', 'unsupported escape')
    reject('\\q', 'unsupported escape')
    reject('\\', 'trailing backslash')
  })

  it('refuses \\xHH — accepted by RE2 itself, but exotic and refused by this narrower filter', () => {
    // Direction-of-divergence pin: m5-1's binding-time checker accepts \xHH;
    // this conversion filter refuses it (queue guidance on exotic escapes).
    // The divergence is safe: refusal is a visible unsupported-key error.
    reject('\\x41', 'conservative filter')
  })

  it('refuses POSIX classes (not part of the ECMA-262 JSON Schema dialect)', () => {
    reject('[[:digit:]]', 'POSIX')
    reject('[a-[:digit:]]', 'POSIX') // also as a range endpoint
    reject('[[:alpha:][:digit:]]', 'POSIX')
  })

  it('refuses structurally malformed patterns', () => {
    reject('(a', 'unbalanced parenthesis')
    reject('a)b', 'unbalanced parenthesis')
    reject('[abc', 'unterminated character class')
    reject('[]', 'unterminated character class')
    reject('[^]', 'unterminated character class')
    reject('[z-a]', 'reversed')
    reject('[😄-😀]', 'reversed') // au3-10: genuinely reversed astral range, code-point reason
    reject('[a-\\d]', 'not a single character')
    reject('[a-[b]]', 'POSIX') // '[' as a range endpoint
    reject('a**', 'nothing to repeat')
    reject('*a', 'nothing to repeat')
    reject('^*', 'nothing to repeat')
    reject('(?i)*', 'nothing to repeat')
    reject('a{1001}', 'exceeds the RE2 limit')
    reject('a{2,1001}', 'exceeds the RE2 limit')
    reject('a{3,2}', 'exceeds maximum')
    // S7 nested-repetition product bound — each quantifier is ≤ 1000 but the
    // product is not; DuckDB 1.5.5 refuses these with `invalid repetition size`.
    reject('(a{32}){32}', 'nested repetition product') // 1024
    reject('(a{31}){33}', 'nested repetition product') // 1023
    reject('(a{100}){11}', 'nested repetition product') // 1100
    reject('(a{1000}){1000}', 'nested repetition product')
    reject('(((a{10}){10}){10}){10}', 'nested repetition product')
    reject('(a{100}){10,11}', 'nested repetition product') // bounded max exceeds
    reject('(a{400,600}){2,}', 'nested repetition product') // inner max × outer min = 1200
  })

  it('refuses flag-group forms beyond the accepted i m s U letters (no negation)', () => {
    reject('(?-i)x', 'unsupported group syntax')
    reject('(?i-s)x', 'unsupported group syntax')
    reject('(?i-)', 'unsupported group syntax')
    reject('(?x)x', 'unsupported group syntax')
    accept('(?ii)') // repeated flag letters are fine — so the refuses above mean "the '-' / the letter", not repetition
    reject('(?)', 'unsupported group syntax')
  })

  it('refuses NUL, non-ASCII escapes, and patterns beyond the nesting bound', () => {
    reject('a\u0000b', 'NUL')
    reject('\\é', 'invalid escape')
    reject('\\😀', 'invalid escape')
    reject(`(${'('.repeat(101)}a${')'.repeat(101)})`, 'nesting bound')
  })
})

describe('astral class ranges are code-point-aware (au3-10)', () => {
  it('accepts an ascending astral range and refuses a reversed one by code point', () => {
    expect(checkRe2SubsetPattern('[😀-😄]')).toEqual({ valid: true })
    const reversed = checkRe2SubsetPattern('[😄-😀]')
    expect(reversed.valid).toBe(false)
    if (!reversed.valid) {
      expect(reversed.reason).toContain('is reversed')
      expect(reversed.reason).toContain('😄-😀')
    }
  })

  it('keeps BMP range behavior byte-stable', () => {
    expect(checkRe2SubsetPattern('[a-z]')).toEqual({ valid: true })
    expect(checkRe2SubsetPattern('[A-Za-z0-9_]')).toEqual({ valid: true })
    expect(checkRe2SubsetPattern('[z-a]').valid).toBe(false)
  })
})

describe('nested-repetition product bound (S7, mirrors the binding-time checker)', () => {
  it('accepts products exactly at the bound and refuses products past it', () => {
    for (const pattern of ['(a{100}){10}', '(a{40}){25}', '((a{10}){10}){10}', '(a{31}){32}']) {
      expect(checkRe2SubsetPattern(pattern), pattern).toEqual({ valid: true })
    }
    for (const pattern of [
      '(a{32}){32}',
      '(a{31}){33}',
      '(a{100}){11}',
      '(a{1000}){1000}',
      '(((a{10}){10}){10}){10}',
    ]) {
      const result = checkRe2SubsetPattern(pattern)
      expect(result.valid, pattern).toBe(false)
      if (!result.valid) expect(result.reason, pattern).toContain('nested repetition product')
    }
  })

  it('unbounded `{n,}` contributes its minimum to the product', () => {
    expect(checkRe2SubsetPattern('(a{100}){10,}')).toEqual({ valid: true })
    expect(checkRe2SubsetPattern('(a{100}){11,}').valid).toBe(false)
    expect(checkRe2SubsetPattern('(a{400,600}){2,}').valid).toBe(false)
  })
})

describe('totality and divergence direction', () => {
  it('never throws for any input, including non-strings', () => {
    for (const input of [undefined, null, 42, { evil: true }, ['a'], Symbol('x')]) {
      expect(() => checkRe2SubsetPattern(input as never)).not.toThrow()
      const result = checkRe2SubsetPattern(input as never)
      expect(result.valid).toBe(false)
      if (!result.valid) expect(result.reason).toContain('must be a string')
    }
  })

  it('long pathological inputs stay total (iterative scan, no runaway recursion)', () => {
    expect(checkRe2SubsetPattern('a'.repeat(50000)).valid).toBe(true)
    expect(checkRe2SubsetPattern('\\'.repeat(50001)).valid).toBe(false) // odd count → trailing backslash
    expect(checkRe2SubsetPattern('[a-z]'.repeat(10000)).valid).toBe(true)
  })

  it('the filter is strictly narrower than the binding-time checker (documented divergences)', () => {
    // Constructs the m5-1 checker accepts and this filter refuses — each
    // refusal is a visible unsupported-key error, never a wrong conversion.
    for (const pattern of ['\\x41', '[[:digit:]]', '(?i-s)x', '\\0']) {
      expect(checkRe2SubsetPattern(pattern).valid).toBe(false)
    }
  })
})
