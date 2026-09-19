import { describe, expect, it } from 'vitest'
import { checkRe2Pattern } from './re2'

/**
 * RE2-subset checker pins (m5-1). The accepted pool is what this compiler
 * promises to bind (m5-2 re-compiles it against real DuckDB); the rejected
 * pool is every documented refusal class with its reason substance. The
 * policy is strict: where a spelling's RE2 acceptance is uncertain, the
 * checker refuses (see the module doc for the asymmetric cost).
 */

const ACCEPTED = [
  '', // empty pattern: valid RE2 (matches everything)
  'abc',
  'ünï cödé', // unicode literals
  'a.c',
  '^anchor$',
  'a|b|c',
  '(a|)b', // empty alternation branch
  '[a-z]+',
  '[^a-z]+',
  '[a-zA-Z0-9_-]{3,12}',
  '[[:alpha:]]+',
  '[[:^digit:]]{2}',
  '[\\d]{4}-[\\d]{2}',
  '[a\\-z]', // escaped range dash
  '[\\]]', // escaped close bracket (the strict-] rule)
  '[\\x41-\\x5A]',
  '\\d{4}-\\d{2}-\\d{2}',
  '\\w+@\\w+',
  '\\s*\\S+',
  '\\bword\\B',
  '\\Atext\\z',
  '\\n\\t\\r\\f\\a',
  '\\x41\\x7A',
  '\\x{1F600}',
  '\\.\\*\\+\\?\\(\\)\\[\\]\\{\\}\\|\\^\\$\\\\', // escaped punctuation
  "it's", // raw quote is a literal
  'a*',
  'a+',
  'a?',
  'a*?',
  'a+?',
  'a??',
  'a{2}',
  'a{2,}',
  'a{2,5}',
  'a{0}',
  'a{2,5}?',
  '(abc)*',
  '(?:abc)+',
  '(?i)abc',
  '(?i)abc',
  '(?im)abc',
  '(?-i)abc',
  '(?i:abc)def',
  '(?i-s:abc)',
  '(?P<year>\\d{4})-(?P<month>\\d{2})',
  '((a)(b))c',
  '(a(b(c)))',
]

const ACCEPT_SHOULD_NOT_INCLUDE: readonly string[] = []

describe('checkRe2Pattern — accepted subset', () => {
  it.each(ACCEPTED.filter((pattern) => !ACCEPT_SHOULD_NOT_INCLUDE.includes(pattern)))(
    'accepts %.40s',
    (pattern) => {
      expect(checkRe2Pattern(pattern)).toEqual({ valid: true })
    },
  )

  it('accepts the m5-0 generator regex pool (compile-level pool already pins these)', () => {
    for (const pattern of [
      '^[A-Z]{2}$',
      '^\\d{4}-\\d{2}-\\d{2}$',
      'user_[0-9]+',
      '@example\\.com$',
      '^(a|b)+c?',
      '[a-z-]+_[0-9]{1,3}',
    ]) {
      expect(checkRe2Pattern(pattern)).toEqual({ valid: true })
    }
  })
})

interface Rejection {
  readonly pattern: string
  readonly reasonSubstance: string
}

const REJECTED: readonly Rejection[] = [
  { pattern: '(a)\\1', reasonSubstance: 'backreferences' },
  { pattern: '\\1', reasonSubstance: 'backreferences' },
  { pattern: '\\0', reasonSubstance: 'backreferences' },
  { pattern: 'a(?=b)', reasonSubstance: 'lookaround' },
  { pattern: 'a(?!b)', reasonSubstance: 'lookaround' },
  { pattern: '(?<=a)b', reasonSubstance: 'lookbehind' },
  { pattern: '(?<!a)b', reasonSubstance: 'lookbehind' },
  { pattern: '(?<name>a)', reasonSubstance: 'lookbehind' },
  { pattern: 'a*+', reasonSubstance: 'nothing to repeat' }, // possessive = nested repetition
  { pattern: 'a**', reasonSubstance: 'nothing to repeat' },
  { pattern: 'a*??', reasonSubstance: 'nothing to repeat' },
  { pattern: 'a{2}{3}', reasonSubstance: 'nothing to repeat' },
  { pattern: 'a(?i)*', reasonSubstance: 'nothing to repeat' }, // flags directive is zero-width
  { pattern: '*a', reasonSubstance: 'nothing to repeat' },
  { pattern: '|*a', reasonSubstance: 'nothing to repeat' },
  { pattern: '^*', reasonSubstance: 'nothing to repeat' },
  { pattern: '$+', reasonSubstance: 'nothing to repeat' },
  { pattern: '\\A?', reasonSubstance: 'nothing to repeat' },
  { pattern: '\\Z', reasonSubstance: '\\Z is not RE2' },
  { pattern: '\\K', reasonSubstance: 'unsupported escape' },
  { pattern: '\\Qa+b\\E', reasonSubstance: '\\Q…\\E quoting' },
  { pattern: '\\E', reasonSubstance: '\\E without \\Q' },
  { pattern: '\\p{L}', reasonSubstance: 'Unicode property/class escapes' },
  { pattern: '\\PL', reasonSubstance: 'Unicode property/class escapes' },
  { pattern: '\\v', reasonSubstance: '\\v is not accepted' },
  { pattern: '[\\v]', reasonSubstance: '\\v is not accepted' },
  { pattern: '[\\b]', reasonSubstance: 'inside a character class' },
  { pattern: '[\\A]', reasonSubstance: 'inside a character class' },
  { pattern: '\\y', reasonSubstance: 'unsupported escape \\y' },
  { pattern: '[\\1]', reasonSubstance: 'decimal escapes' }, // \1 inside class → decimal escape refusal
  { pattern: 'a{1001}', reasonSubstance: 'exceeds the RE2 limit' },
  { pattern: 'a{2,1001}', reasonSubstance: 'exceeds the RE2 limit' },
  { pattern: 'a{3,2}', reasonSubstance: 'minimum 3 exceeds maximum 2' },
  { pattern: '(unclosed', reasonSubstance: 'unbalanced parenthesis' },
  { pattern: 'a\\', reasonSubstance: 'trailing backslash' },
  { pattern: 'x)', reasonSubstance: 'unbalanced parenthesis' },
  { pattern: '(?=)', reasonSubstance: 'lookaround' },
  { pattern: '(?P<1bad>a)', reasonSubstance: 'invalid capture-group name' },
  { pattern: '(?P<>a)', reasonSubstance: 'invalid capture-group name' },
  { pattern: '(?P=name)', reasonSubstance: 'malformed (?P' },
  { pattern: '(?Pa)', reasonSubstance: 'malformed (?P' },
  { pattern: '(?u)a', reasonSubstance: 'unsupported group syntax' }, // 'u' is not an RE2 flag letter
  { pattern: '(?)a', reasonSubstance: 'unsupported group syntax' },
  { pattern: '(?Z)a', reasonSubstance: 'unsupported group syntax' },
  { pattern: '[a-', reasonSubstance: 'unterminated character class' },
  { pattern: '[', reasonSubstance: 'unterminated character class' },
  { pattern: '[]', reasonSubstance: 'empty character class' },
  { pattern: '[]a]', reasonSubstance: 'empty character class' },
  { pattern: '[z-a]', reasonSubstance: 'is reversed' },
  { pattern: '[a-\\d]', reasonSubstance: 'upper bound is not a single character' },
  { pattern: '[a-[:alpha:]]', reasonSubstance: 'upper bound is a POSIX class' },
  { pattern: '[[:foo:]]', reasonSubstance: 'unknown POSIX class name' },
  { pattern: '[[:alpha]]', reasonSubstance: 'malformed POSIX class' },
  { pattern: '\\x', reasonSubstance: 'two hex digits' },
  { pattern: '\\xZZ', reasonSubstance: 'two hex digits' },
  { pattern: '\\x{}', reasonSubstance: 'invalid \\x{…} escape' },
  { pattern: '\\x{110000}', reasonSubstance: 'exceeds the Unicode range' },
  { pattern: 'a\u0000b', reasonSubstance: 'NUL character' },
]

describe('checkRe2Pattern — rejected with stable reasons', () => {
  it.each(REJECTED)('rejects %.40s', ({ pattern, reasonSubstance }) => {
    const check = checkRe2Pattern(pattern)
    expect(check.valid).toBe(false)
    if (check.valid) return
    expect(check.reason).toContain(reasonSubstance)
  })

  it('never throws on adversarial inputs', () => {
    const adversarial = [
      '',
      '(',
      ')',
      '[]',
      '\\',
      '\\\\',
      '((((((((((',
      ']]]]]]]]]]',
      '(?:',
      '(?P<',
      '{',
      '{,5}',
      'a{',
      '{}',
      'a}{',
      '(?#comment)',
      "(?'x'a)",
      'a' + '*'.repeat(100),
    ]
    for (const pattern of adversarial) {
      expect(() => checkRe2Pattern(pattern)).not.toThrow()
    }
    // a lone '{' stays a literal (RE2's rule), so it is accepted
    expect(checkRe2Pattern('{')).toEqual({ valid: true })
    expect(checkRe2Pattern('a{')).toEqual({ valid: true })
    expect(checkRe2Pattern('a{,5}')).toEqual({ valid: true }) // not a quantifier shape → literal
    expect(checkRe2Pattern('{}')).toEqual({ valid: true })
    expect(checkRe2Pattern('a}{')).toEqual({ valid: true })
  })
})
