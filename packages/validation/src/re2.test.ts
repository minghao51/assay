// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { sqlStringLiteral } from './literals'
import { checkRe2Pattern } from './re2'

/**
 * RE2-subset checker pins (m5-1). The accepted pool is what this compiler
 * promises to bind (m5-2 re-compiles it against real DuckDB); the rejected
 * pool is every documented refusal class with its reason substance. The
 * policy is strict: where a spelling's RE2 acceptance is uncertain, the
 * checker refuses (see the module doc for the asymmetric cost).
 *
 * The pool's size is itself pinned (50 unique patterns after the m5-1
 * re-review round 2 — which added the three claimed accepted-edge flag
 * patterns and removed an accidental `(?i)abc` duplicate; see the
 * "accepted pool is the claim" describe), and every entry is executed
 * against the pinned DuckDB CLI in the gated suite below.
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
  '(?im)abc',
  '(?-i)abc',
  '(?ii)', // repeated flag letters — the m5-1 round-2 claimed accepted edges
  '(?i-i)', // on-then-off within one group
  '(?-imsU:)', // negated full flag set, group form
  '(?i:abc)def',
  '(?i-s:abc)',
  '(?P<year>\\d{4})-(?P<month>\\d{2})',
  '((a)(b))c',
  '(a(b(c)))',
  // AR-V1 acceptances (DuckDB 1.5.5-verified): the checker previously
  // refused these as policy; aligned with real RE2/DuckDB behavior.
  '\\v', // vertical tab (RE2 defines it)
  '[\\v]',
  '[]a]', // leading ] is a literal class member
  '[]]',
  '[^]a]',
  '^*', // zero-width anchors/boundaries are quantifiable
  '$+',
  '^{2,3}',
  '\\b{2}',
  '\\B+',
  '\\A?',
  '\\z{2}',
  'a(?i)*', // a quantifier after a (?flags) directive binds to the atom before it
  '\\x{0000061}', // zero-padded hex escapes inside the Unicode range
  '\\x{00000000000000000000000000000000000000000000000000000000000000000061}',
  // S7 nested-repetition boundary: products exactly at (or under) the real
  // RE2 product bound of 1000 (DuckDB 1.5.5-verified; see the dedicated
  // describe below and the module doc's MAX_REPEAT_PRODUCT).
  '(a{40}){25}', // 40 × 25 = 1000
  '((a{10}){10}){10}', // 10 × 10 × 10 = 1000, three levels deep
  '(a{1000}){1}', // 1000 × 1 = 1000
  '(a{31}){32}', // 31 × 32 = 992
  '(a{100}){10,}', // unbounded max contributes its minimum 10 → 1000
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

describe('checkRe2Pattern — the accepted pool is the claim (m5-1 re-review round 2)', () => {
  it('the accepted pool has its exact size and uniqueness pinned — 70 unique patterns, all DuckDB-executed', () => {
    expect(ACCEPTED).toHaveLength(70)
    expect(new Set(ACCEPTED).size).toBe(ACCEPTED.length)
  })

  it('the three claimed accepted-edge flag patterns are in the pool and accepted', () => {
    for (const pattern of ['(?ii)', '(?i-i)', '(?-imsU:)']) {
      expect(ACCEPTED).toContain(pattern)
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
  { pattern: '(?i)*', reasonSubstance: 'nothing to repeat' }, // a flags directive with nothing before it
  { pattern: '*a', reasonSubstance: 'nothing to repeat' },
  { pattern: '|*a', reasonSubstance: 'nothing to repeat' },
  { pattern: '\\Z', reasonSubstance: '\\Z is not RE2' },
  { pattern: '\\K', reasonSubstance: 'unsupported escape' },
  { pattern: '\\Qa+b\\E', reasonSubstance: '\\Q…\\E quoting' },
  { pattern: '\\E', reasonSubstance: '\\E without \\Q' },
  { pattern: '\\p{L}', reasonSubstance: 'Unicode property/class escapes' },
  { pattern: '\\PL', reasonSubstance: 'Unicode property/class escapes' },
  { pattern: '[\\b]', reasonSubstance: 'inside a character class' },
  { pattern: '[\\A]', reasonSubstance: 'inside a character class' },
  { pattern: '\\y', reasonSubstance: 'unsupported escape \\y' },
  { pattern: '[\\1]', reasonSubstance: 'decimal escapes' }, // \1 inside class → decimal escape refusal
  { pattern: 'a{1001}', reasonSubstance: 'exceeds the RE2 limit' },
  { pattern: 'a{2,1001}', reasonSubstance: 'exceeds the RE2 limit' },
  { pattern: 'a{3,2}', reasonSubstance: 'minimum 3 exceeds maximum 2' },
  // S7 nested-repetition PRODUCT bound: each quantifier is ≤ 1000 but the
  // accumulated product is not. DuckDB 1.5.5 throws `invalid repetition
  // size` for every one of these (the audit's live finding).
  { pattern: '(a{32}){32}', reasonSubstance: 'nested repetition product' }, // 1024
  { pattern: '(a{31}){33}', reasonSubstance: 'nested repetition product' }, // 1023
  { pattern: '(a{100}){11}', reasonSubstance: 'nested repetition product' }, // 1100
  { pattern: '(a{1000}){1000}', reasonSubstance: 'nested repetition product' }, // the audit case
  { pattern: '(((a{10}){10}){10}){10}', reasonSubstance: 'nested repetition product' }, // 10^4, deep
  { pattern: '(a{100}){10,11}', reasonSubstance: 'nested repetition product' }, // bounded max 11
  { pattern: '(a{400,600}){2,}', reasonSubstance: 'nested repetition product' }, // inner max 600 × outer min 2
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
  { pattern: '[]', reasonSubstance: 'unterminated character class' },
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

describe('checkRe2Pattern — the nesting bound is typed data, never a throw (m5-1 review item 3)', () => {
  const nest = (n: number): string => '('.repeat(n) + 'a' + ')'.repeat(n)

  it('accepts nesting at the documented bound (100)', () => {
    expect(checkRe2Pattern(nest(100))).toEqual({ valid: true })
  })

  it('refuses past the bound as invalid-regex data — never a RangeError', () => {
    for (const depth of [101, 1000, 5000]) {
      let check: ReturnType<typeof checkRe2Pattern> | undefined
      expect(() => {
        check = checkRe2Pattern(nest(depth))
      }, `depth ${depth}`).not.toThrow()
      expect(check?.valid, `depth ${depth}`).toBe(false)
      if (check !== undefined && !check.valid) {
        expect(check.reason, `depth ${depth}`).toContain('nest')
        expect(check.reason).toContain('100')
      }
    }
  })
})

describe('checkRe2Pattern — nested-repetition product bound (S7, DuckDB 1.5.5-verified)', () => {
  // The per-quantifier limit is not the whole story: DuckDB/RE2 multiply the
  // enclosing repeat counts and cap the product at 1000. A contract or
  // validation regex that passed the per-quantifier check could therefore
  // still throw `Invalid Input Error: invalid repetition size` at engine
  // execution. These are the /tmp/vc-audit drills made permanent.

  it('accepts products exactly at the bound (1000)', () => {
    for (const pattern of [
      '(a{100}){10}',
      '(a{40}){25}',
      '(a{1000}){1}',
      '((a{10}){10}){10}',
      '(a{2}){500}',
      '(a{31}){32}',
      '(a{100}){10,}',
    ]) {
      expect(checkRe2Pattern(pattern), pattern).toEqual({ valid: true })
    }
  })

  it('refuses products past the bound with a stable, value-free reason', () => {
    for (const pattern of [
      '(a{32}){32}', // 1024 — the audit's boundary probe
      '(a{31}){33}', // 1023
      '(a{100}){11}', // 1100
      '(a{1000}){1000}', // the audit's checker-over-acceptance
      '(((a{10}){10}){10}){10}', // 10^4, three levels of nesting
      '(a{100}){10,11}', // bounded max exceeds
      '(a{400,600}){2,}', // unbounded outer uses the inner max
    ]) {
      const check = checkRe2Pattern(pattern)
      expect(check.valid, pattern).toBe(false)
      if (!check.valid) {
        expect(check.reason, pattern).toContain('nested repetition product')
        expect(check.reason, pattern).toContain('1000')
      }
    }
  })

  it('the audit case (a{1000}){1000} is no longer checker-accepted', () => {
    // Regression pin for the exact finding in S7.
    expect(checkRe2Pattern('(a{1000}){1000}')).toEqual({
      valid: false,
      reason: expect.stringContaining('nested repetition product'),
    })
  })
})

/**
 * Real-DuckDB agreement pins (env-gated). The checker's promise is that
 * everything it ACCEPTS is valid DuckDB RE2 — the m5-2 engine work
 * re-compiles accepted patterns there — so the accepted pool is executed
 * against the pinned CLI, and the review-reported over-acceptances are
 * pinned as DuckDB-rejected (defect evidence). Skipped only when the
 * pinned binary is absent (e.g. a CI image without it — the documented
 * skip reason); where it exists these pins must run.
 */
const DUCKDB_CLI = process.env['DUCKDB'] ?? '/tmp/duckdb'
const hasDuckDbCli = existsSync(DUCKDB_CLI)

/** Whether DuckDB accepts the pattern (process exit code is the oracle). */
function duckdbAcceptsRegex(pattern: string): boolean {
  const sql = `SELECT regexp_full_match('abc', ${sqlStringLiteral(pattern)});`
  try {
    execFileSync(DUCKDB_CLI, ['-json', '-noheader', '-c', sql], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

function nestFor(n: number): string {
  return '('.repeat(n) + 'a' + ')'.repeat(n)
}

describe.skipIf(!hasDuckDbCli)('checkRe2Pattern — real DuckDB agreement (pinned CLI 1.5.5)', () => {
  it('pins the dialect: the CLI is the 1.5.x series', () => {
    const version = execFileSync(DUCKDB_CLI, ['--version'], { encoding: 'utf8' })
    expect(version).toMatch(/v1\.5\./)
  })

  it('every accepted pattern is accepted by real DuckDB (the accepted pool is the contract)', () => {
    for (const pattern of ACCEPTED) {
      expect(duckdbAcceptsRegex(pattern), `pattern ${JSON.stringify(pattern)}`).toBe(true)
    }
  })

  it('the review-reported over-acceptances are DuckDB-rejected (defect evidence)', () => {
    for (const pattern of ['(?i-)abc', '(?i--s)abc', '\\é', '\\😀']) {
      expect(duckdbAcceptsRegex(pattern), `pattern ${JSON.stringify(pattern)}`).toBe(false)
    }
  })

  it('AR-V1 — the previously-refused pool members are DuckDB-accepted and the checker now agrees', () => {
    const newlyAccepted = [
      '\\v',
      '[\\v]',
      '[]a]',
      '[]]',
      '[^]a]',
      '^*',
      '$+',
      '^{2,3}',
      '\\b{2}',
      '\\B+',
      '\\A?',
      '\\z{2}',
      'a(?i)*',
      '\\x{0000061}',
      '\\x{00000000000000000000000000000000000000000000000000000000000000000061}',
    ]
    for (const pattern of newlyAccepted) {
      expect(duckdbAcceptsRegex(pattern), `DuckDB accepts ${JSON.stringify(pattern)}`).toBe(true)
      expect(checkRe2Pattern(pattern), `checker accepts ${JSON.stringify(pattern)}`).toEqual({
        valid: true,
      })
    }
    // The distinguishing refusal (there is nothing before the flags directive).
    expect(duckdbAcceptsRegex('(?i)*')).toBe(false)
    expect(checkRe2Pattern('(?i)*').valid).toBe(false)
    // Genuinely-out-of-range zero-padded hex stays refused by both.
    for (const pattern of ['\\x{110000}', '\\x{0000110000}', '\\x{FFFFFFFFFFFFFFFF}']) {
      expect(duckdbAcceptsRegex(pattern), `DuckDB rejects ${JSON.stringify(pattern)}`).toBe(false)
      expect(checkRe2Pattern(pattern).valid).toBe(false)
    }
  })

  it('the nesting bound is a checker bound, not a DuckDB one (DuckDB accepts 5,000 deep)', () => {
    expect(duckdbAcceptsRegex(nestFor(100))).toBe(true) // inside our bound: both accept
    expect(duckdbAcceptsRegex(nestFor(5000))).toBe(true) // past our bound: DuckDB still accepts — we refuse as documented strictness
  })

  it('decimal escapes: DuckDB 1.5.5 accepts \\0 (octal NUL) but rejects \\1–\\9 — the checker refuses the whole class (documented stricter policy)', () => {
    // DuckDB's actual split behavior (m5-1 re-review round 2, CLI-verified):
    // \0 (and longer leading-zero octal forms like \012) is RE2's octal
    // character-code escape — \0 matches the NUL byte — while \1–\9 are
    // backreference escapes and die with "invalid escape sequence". The
    // checker refuses the entire \\0–\\9 class regardless: a NUL-byte
    // pattern is unbindable in the compiled SQL text, and no decimal
    // spelling is ever silently re-read as a byte escape (re2.ts "Rejected").
    expect(duckdbAcceptsRegex('\\0')).toBe(true)
    expect(duckdbAcceptsRegex('\\012')).toBe(true)
    expect(checkRe2Pattern('\\0').valid).toBe(false)
    for (const pattern of ['\\1', '\\2', '\\7', '\\8', '\\9']) {
      expect(duckdbAcceptsRegex(pattern), `pattern ${JSON.stringify(pattern)}`).toBe(false)
      expect(checkRe2Pattern(pattern).valid).toBe(false)
    }
  })
})

describe.skipIf(!hasDuckDbCli)(
  'checkRe2Pattern — nested-repetition product bound vs real DuckDB (S7, pinned CLI 1.5.5)',
  () => {
    const acceptedBoundary = [
      '(a{100}){10}',
      '(a{40}){25}',
      '(a{1000}){1}',
      '((a{10}){10}){10}',
      '(a{2}){500}',
      '(a{100}){10,}',
    ]
    const refusedOverBound = [
      '(a{32}){32}',
      '(a{31}){33}',
      '(a{100}){11}',
      '(a{1000}){1000}',
      '(((a{10}){10}){10}){10}',
      '(a{100}){10,11}',
      '(a{400,600}){2,}',
    ]

    it('the checker-accepted boundary is DuckDB-accepted', () => {
      for (const pattern of acceptedBoundary) {
        expect(duckdbAcceptsRegex(pattern), `DuckDB accepts ${pattern}`).toBe(true)
        expect(checkRe2Pattern(pattern), `checker accepts ${pattern}`).toEqual({ valid: true })
      }
    })

    it('the checker-refused over-bound is DuckDB-thrown (closing the audit gap)', () => {
      for (const pattern of refusedOverBound) {
        expect(duckdbAcceptsRegex(pattern), `DuckDB rejects ${pattern}`).toBe(false)
        expect(checkRe2Pattern(pattern).valid, `checker refuses ${pattern}`).toBe(false)
      }
    })
  },
)
