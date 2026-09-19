/**
 * RE2-subset pattern checker (m5-1) — **binding-time dialect honesty** for
 * `regex` rules.
 *
 * DuckDB's regex engine is RE2 (no backreferences, no lookarounds). A
 * pattern authored against PCRE habits that RE2 rejects must be a **typed
 * binding error**, never a runtime surprise — so the compiler validates
 * every `regex` pattern here before any SQL exists. This module is a pure,
 * hand-written recursive-descent checker documenting *exactly* which RE2
 * subset is accepted; the m5-2 engine agreement test re-compiles accepted
 * patterns against real DuckDB, and the policy is to **bias strict**: where
 * this checker is unsure whether DuckDB's RE2 build accepts a spelling, the
 * spelling is rejected (a valid pattern wrongly refused is a visible,
 * actionable binding error; an invalid one wrongly accepted is a runtime
 * failure — the asymmetric cost is clear).
 *
 * ## Accepted (documented subset)
 *
 * - literals (any codepoint except NUL); `.`, `^`, `$`, `|`; the empty
 *   pattern (RE2-valid: matches everything)
 * - groups: `(...)`, `(?:...)`, flags `(?flags)` / `(?flags:...)` with
 *   flags from `imsU` (repeats allowed), named `(?P<name>...)`. The flag
 *   grammar is RE2's exact one — an optional single negation `-` that
 *   must introduce at least one further flag letter (`(?i)`, `(?-i)`,
 *   `(?i-s)`, `(?ii)` accept; `(?i-)`, `(?--i)`, `(?i--s)` are DuckDB's
 *   "invalid perl operator" and are refused — pinned against DuckDB
 *   1.5.5, see the regression pins in `re2.test.ts`)
 * - quantifiers `* + ? {n} {n,} {n,m}` with optional lazy `?`; RE2's
 *   documented limits hold (`n,m ≤ 1000`, `n ≤ m`); only repeatable atoms
 *   quantify (no `a**`, no `^*`, no `(?i)*`)
 * - character classes with ranges, negation, POSIX classes
 *   `[:name:]`/`[:^name:]` from the fourteen POSIX names, and the
 *   shorthand escapes below as items
 * - escapes: shorthands `\d \D \s \S \w \W`; anchors `\b \B \A \z`
 *   (outside classes); controls `\n \t \r \f \a`; hex `\xHH`/`\x{h…}`
 *   (≤ U+10FFFF); any escaped **ASCII non-alphanumeric** character as a
 *   literal. An escaped non-ASCII codepoint (`\é`, `\😀`) is RE2's
 *   "invalid escape sequence" (DuckDB 1.5.5 rejects it; pinned) and is
 *   refused here — only ASCII punctuation/spaces can be escaped
 *
 * ## Rejected (each with a stable reason string)
 *
 * - decimal escapes `\0`–`\9`: RE2 has no backreferences and would
 *   silently read `\1` as the byte U+0001 — refused outright (DuckDB 1.5.5
 *   rejects them too, as "invalid escape sequence")
 * - escaped non-ASCII codepoints (`\é`, `\😀`): RE2's "invalid escape
 *   sequence" (pinned against DuckDB 1.5.5) — only ASCII
 *   non-alphanumerics can be escaped
 * - flag-grammar violations: a trailing or doubled `-` (`(?i-)`,
 *   `(?--i)`, `(?i--s)`) — DuckDB's "invalid perl operator" — plus
 *   unknown flag letters and empty flag groups
 * - lookarounds `(?= (?! (?<= (?<!` and the lookbehind-shaped `(?<`
 *   (including `(?<name>` — some RE2 builds accept named groups that way;
 *   refused here for lookbehind-ambiguity, `(?P<name>` is the spelling)
 * - possessive quantifiers (surface as nested repetition), `\K`, `\Z`,
 *   `\Q…\E` quoting, Unicode classes `\p{…}`/`\P{…}`, octal escapes,
 *   `\v`, `\b`/`\B`/`\A`/`\z` inside classes, unknown letter escapes
 * - structural errors: unbalanced groups/classes, empty classes (`]`
 *   always terminates — `[]a]` is refused, RE2's own error is near), a
 *   `]`-must-be-escaped strictness, reversed class ranges, malformed POSIX
 *   names, malformed hex escapes, NUL characters
 *
 * ## Bounds and totality (the checker never throws)
 *
 * The parser is recursive descent over the JS stack, so group nesting is
 * bounded: at most {@link MAX_NESTING_DEPTH} (100) levels of `(...)` are
 * walked. This is a **checker-safety bound, not an RE2 rule** — DuckDB
 * 1.5.5 accepts patterns far deeper (5,000 nested groups were verified to
 * run), so a pattern past the bound is refused as typed `invalid-regex`
 * *data* (with the bound named in the reason) even though DuckDB would
 * run it: the documented strictness asymmetry — a valid pattern wrongly
 * refused is a visible, actionable binding error; a checker crash is a
 * totality violation. Contract patterns are human/YAML-authored, where
 * depth beyond 100 is not meaningful. Everything except group nesting is
 * parsed iteratively, so no input-size bound is needed; `checkRe2Pattern`
 * is total over every input and never throws.
 *
 * Not part of the injection boundary (a pattern reaches SQL only through
 * `sqlStringLiteral`); this module decides *validity*, never escaping.
 *
 * Purity: pure string logic — no React, no browser APIs, no engine imports.
 */

/** Outcome of checking one pattern. `reason` is stable, pin-able text. */
export type Re2PatternCheck =
  { readonly valid: true } | { readonly valid: false; readonly reason: string }

/** RE2's documented repeat-count limit (RE2 and Go's regexp both enforce 1000). */
const MAX_REPEAT = 1000

/**
 * The deepest group nesting the checker walks (see the module doc's
 * "Bounds and totality" section): past this, a pattern is refused as
 * typed data — the recursive descent must never overflow the JS stack.
 */
const MAX_NESTING_DEPTH = 100

const POSIX_CLASS_NAMES: ReadonlySet<string> = new Set([
  'alnum',
  'alpha',
  'ascii',
  'blank',
  'cntrl',
  'digit',
  'graph',
  'lower',
  'print',
  'punct',
  'space',
  'upper',
  'word',
  'xdigit',
])

/** Group-flag letters accepted inside `(?…)` constructs (`-` is negation). */
const FLAG_LETTERS: ReadonlySet<string> = new Set(['i', 'm', 's', 'U'])

/**
 * Internal rejection signal; `checkRe2Pattern` catches it and returns the
 * reason as data. It never escapes this module.
 */
class PatternRejected extends Error {}

function reject(reason: string): never {
  throw new PatternRejected(reason)
}

/** Parser cursor over UTF-16 code units. */
interface Cursor {
  readonly src: string
  at: number
  /** Current `(...)` nesting depth (bounded by {@link MAX_NESTING_DEPTH}). */
  depth: number
}

function peek(cursor: Cursor, offset = 0): string {
  return cursor.src[cursor.at + offset] ?? ''
}

function consume(cursor: Cursor): string {
  const ch = cursor.src[cursor.at] ?? ''
  cursor.at += 1
  return ch
}

function atEnd(cursor: Cursor): boolean {
  return cursor.at >= cursor.src.length
}

/**
 * What one escape resolves to. `'char'` carries the resolved codepoint
 * (usable as a class-range endpoint); `'class'` is a shorthand class
 * (`\d`…, never a range endpoint); `'zero'` is a zero-width anchor.
 */
type EscapeResolution =
  | { readonly kind: 'char'; readonly value: string }
  | { readonly kind: 'class' }
  | { readonly kind: 'zero' }

/**
 * Parse one escape sequence (the cursor sits on the character after the
 * backslash). `inClass` selects the class-context rules (anchors refuse).
 */
function parseEscape(cursor: Cursor, inClass: boolean): EscapeResolution {
  if (atEnd(cursor)) reject('trailing backslash')
  const ch = consume(cursor)
  if (ch >= '0' && ch <= '9') {
    reject(
      'decimal escapes \\0–\\9 are refused: RE2 has no backreferences and would silently read them as byte escapes',
    )
  }
  if (ch.charCodeAt(0) > 0x7f) {
    // Checked before the letter tests: a non-ASCII codepoint can never be
    // an RE2 escape, and DuckDB 1.5.5 rejects `\é`/`\😀` outright
    // ("invalid escape sequence") — pinned in re2.test.ts.
    reject(`invalid escape sequence (\\${ch} — only ASCII punctuation and spaces can be escaped)`)
  }
  switch (ch) {
    case 'd':
    case 'D':
    case 's':
    case 'S':
    case 'w':
    case 'W':
      return { kind: 'class' }
    case 'b':
    case 'B':
      if (inClass) reject(`\\${ch} inside a character class is not accepted by this checker`)
      return { kind: 'zero' }
    case 'A':
    case 'z':
      if (inClass) reject(`\\${ch} inside a character class is not accepted by this checker`)
      return { kind: 'zero' }
    case 'n':
    case 't':
    case 'r':
    case 'f':
    case 'a': {
      const values: Readonly<Record<string, string>> = {
        n: '\n',
        t: '\t',
        r: '\r',
        f: '\f',
        a: '\u0007',
      }
      return { kind: 'char', value: values[ch] ?? '' }
    }
    case 'v':
      return reject('\\v is not accepted by this checker (use the literal character or \\x0B)')
    case 'x':
      return { kind: 'char', value: parseHexEscape(cursor) }
    case 'p':
    case 'P':
      return reject(
        `\\${ch} Unicode property/class escapes are not accepted by this v1 checker (spell the characters out)`,
      )
    case 'Z':
      return reject('\\Z is not RE2 (RE2 has \\z only)')
    case 'Q':
      return reject(
        '\\Q…\\E quoting is not accepted by this checker (escape the characters instead)',
      )
    case 'E':
      return reject('\\E without \\Q is not accepted by this checker')
    default:
      if (/[A-Za-z]/.test(ch)) return reject(`unsupported escape \\${ch}`)
      // Escaped ASCII non-alphanumeric (punctuation, space, …) is a
      // literal — RE2's own rule, pinned against DuckDB 1.5.5. Non-ASCII
      // was already refused above.
      return { kind: 'char', value: ch }
  }
}

/** Parse `\xHH` or `\x{h…}`; validates hex digits and the Unicode range. */
function parseHexEscape(cursor: Cursor): string {
  if (peek(cursor) === '{') {
    consume(cursor)
    let digits = ''
    while (!atEnd(cursor) && peek(cursor) !== '}') {
      digits += consume(cursor)
    }
    if (peek(cursor) !== '}') reject('unterminated \\x{…} escape')
    consume(cursor)
    if (!/^[0-9a-fA-F]+$/.test(digits)) reject(`invalid \\x{…} escape (\\x{${digits}})`)
    if (digits.length > 6 || Number.parseInt(digits, 16) > 0x10ffff) {
      reject(`\\x{${digits}} exceeds the Unicode range`)
    }
    return String.fromCodePoint(Number.parseInt(digits, 16))
  }
  const hex = peek(cursor, 0) + peek(cursor, 1)
  if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
    reject(`\\x escape needs exactly two hex digits (got \\x${hex})`)
  }
  cursor.at += 2
  return String.fromCodePoint(Number.parseInt(hex, 16))
}

/**
 * Whether the `{` at the cursor starts a valid quantifier shape
 * (`{n}`, `{n,}`, `{n,m}` — digits only, no spaces). Pure lookahead: the
 * cursor does not move. Non-shaped braces stay literal (RE2's own rule),
 * but well-shaped violations (`{1001}`, `{3,2}`) reject — RE2 rejects
 * those too.
 */
function quantifierShapeAt(cursor: Cursor): boolean {
  let i = cursor.at + 1
  let minDigits = ''
  while (i < cursor.src.length && cursor.src[i] >= '0' && cursor.src[i] <= '9') {
    minDigits += cursor.src[i]
    i += 1
  }
  if (minDigits.length === 0) return false
  let maxDigits: string | null = null
  if (cursor.src[i] === ',') {
    i += 1
    maxDigits = ''
    while (i < cursor.src.length && cursor.src[i] >= '0' && cursor.src[i] <= '9') {
      maxDigits += cursor.src[i]
      i += 1
    }
  }
  if (cursor.src[i] !== '}') return false
  const min = Number(minDigits)
  const max = maxDigits === null || maxDigits === '' ? null : Number(maxDigits)
  if (min > MAX_REPEAT) reject(`repetition count ${min} exceeds the RE2 limit of ${MAX_REPEAT}`)
  if (max !== null) {
    if (max > MAX_REPEAT) reject(`repetition count ${max} exceeds the RE2 limit of ${MAX_REPEAT}`)
    if (max < min) reject(`repetition minimum ${min} exceeds maximum ${max}`)
  }
  return true
}

/** Consume a quantifier character plus its optional lazy `?`. The caller
 * has verified a repeatable atom precedes and — for braces — that a valid
 * quantifier shape is at the cursor. */
function consumeQuantifier(cursor: Cursor): void {
  if (peek(cursor) === '{') {
    // quantifierShapeAt already validated the closing '}' exists ahead.
    cursor.at = cursor.src.indexOf('}', cursor.at) + 1
  } else {
    consume(cursor)
  }
  if (peek(cursor) === '?') consume(cursor)
}

/**
 * Parse one atom starting at the cursor (anything but a quantifier
 * character, `|`, or a group close). Returns whether the atom is
 * quantifiable — zero-width tokens (anchors, `(?flags)` directives) are not.
 */
function parseAtom(cursor: Cursor): { readonly quantifiable: boolean } {
  const ch = consume(cursor)
  switch (ch) {
    case '^':
    case '$':
      return { quantifiable: false }
    case '.':
      return { quantifiable: true }
    case '[':
      parseClass(cursor)
      return { quantifiable: true }
    case '(':
      return parseGroup(cursor)
    case '\\': {
      const resolution = parseEscape(cursor, false)
      return { quantifiable: resolution.kind !== 'zero' }
    }
    default:
      return { quantifiable: true } // literal (including a non-quantifier `{`)
  }
}

/**
 * Parse a `(...)`-group; returns whether it is quantifiable. The nesting
 * depth guard makes the recursive descent total: past the documented
 * bound the pattern is refused as data (never a stack-overflow throw).
 */
function parseGroup(cursor: Cursor): { readonly quantifiable: boolean } {
  cursor.depth += 1
  if (cursor.depth > MAX_NESTING_DEPTH) {
    reject(
      `pattern nests groups more than ${MAX_NESTING_DEPTH} deep (this checker's documented nesting bound — deep patterns are refused as data, not walked)`,
    )
  }
  try {
    return parseGroupBody(cursor)
  } finally {
    cursor.depth -= 1
  }
}

/** The `(...)`-group body (depth-guarded by {@link parseGroup}). */
function parseGroupBody(cursor: Cursor): { readonly quantifiable: boolean } {
  if (peek(cursor) !== '?') {
    parseAlternation(cursor)
    expectGroupClose(cursor)
    return { quantifiable: true }
  }
  consume(cursor) // '?'
  if (atEnd(cursor)) reject('unbalanced parenthesis')
  const ch = peek(cursor)
  if (ch === ':') {
    consume(cursor)
    parseAlternation(cursor)
    expectGroupClose(cursor)
    return { quantifiable: true }
  }
  if (ch === 'P') {
    consume(cursor)
    if (peek(cursor) !== '<') reject('malformed (?P… group (expected (?P<name>))')
    consume(cursor)
    parseGroupName(cursor)
    if (peek(cursor) !== '>') reject('unterminated (?P<name> group')
    consume(cursor)
    parseAlternation(cursor)
    expectGroupClose(cursor)
    return { quantifiable: true }
  }
  if (ch === '=' || ch === '!') {
    reject('lookaround ((?=…), (?!…)) is not RE2')
  }
  if (ch === '<') {
    reject(
      '(?<… is not accepted: lookbehind ((?<=, (?<!) is not RE2, and the (?<name> spelling is refused by this strict checker — use (?P<name>',
    )
  }
  // Flags: (?flags) or (?flags:...) — RE2's exact flag grammar: flag
  // letters from the accepted set, with at most ONE '-' that must
  // introduce at least one further letter before ')' or ':'. DuckDB's
  // RE2 build rejects a trailing or doubled '-' ("invalid perl operator:
  // (?i-)" / "(?--") — pinned in re2.test.ts — so the checker refuses
  // them here.
  let on = 0
  let off: number | null = null
  for (;;) {
    const flag = peek(cursor)
    if (FLAG_LETTERS.has(flag)) {
      if (off !== null) off += 1
      else on += 1
      consume(cursor)
    } else if (flag === '-') {
      if (off !== null) reject("malformed flag group (only one '-' is allowed)")
      off = 0
      consume(cursor)
    } else break
    if (atEnd(cursor)) reject('unbalanced parenthesis')
  }
  if (off === 0) reject(`malformed flag group (expected a flag letter after '-')`)
  if (on === 0 && off === null) reject(`unsupported group syntax (?${ch}…`)
  if (peek(cursor) === ')') {
    consume(cursor)
    return { quantifiable: false } // a flags directive matches nothing
  }
  if (peek(cursor) === ':') {
    consume(cursor)
    parseAlternation(cursor)
    expectGroupClose(cursor)
    return { quantifiable: true }
  }
  reject(`unsupported group syntax (?…${peek(cursor)}`)
}

function expectGroupClose(cursor: Cursor): void {
  if (peek(cursor) !== ')') reject('unbalanced parenthesis')
  consume(cursor)
}

/** Parse a named-group identifier: `[A-Za-z_][A-Za-z0-9_]*` (strict). */
function parseGroupName(cursor: Cursor): void {
  let name = ''
  while (!atEnd(cursor) && /[A-Za-z0-9_]/.test(peek(cursor))) {
    name += consume(cursor)
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) reject(`invalid capture-group name ('${name}')`)
}

/**
 * Parse a `[...]` character class (the cursor sits just past the `[`).
 * Strict `]` handling: `]` always terminates the class (so `[]a]` is an
 * empty class followed by garbage — refused), and a literal `]` must be
 * escaped (`\]`).
 */
function parseClass(cursor: Cursor): void {
  if (peek(cursor) === '^') consume(cursor)
  let items = 0
  // The previous item when it was a single character — the only legal lower
  // bound of a range. Class-shorthand/POSIX items and ranges clear it.
  let prevChar: string | null = null
  for (;;) {
    if (atEnd(cursor)) reject('unterminated character class')
    const ch = peek(cursor)
    if (ch === ']') {
      if (items === 0) reject('empty character class (escape a literal ] as \\])')
      consume(cursor)
      return
    }
    if (ch === '[' && peek(cursor, 1) === ':') {
      parsePosixClass(cursor)
      items += 1
      prevChar = null
      continue
    }
    if (ch === '\\') {
      consume(cursor)
      const resolution = parseEscape(cursor, true)
      if (resolution.kind === 'char') {
        prevChar = resolution.value
      } else {
        prevChar = null
      }
      items += 1
      continue
    }
    if (ch === '-' && prevChar !== null && peek(cursor, 1) !== '' && peek(cursor, 1) !== ']') {
      consume(cursor) // '-'
      const lower = prevChar.codePointAt(0) ?? 0
      let upper: number
      if (peek(cursor) === '\\') {
        consume(cursor)
        const resolution = parseEscape(cursor, true)
        if (resolution.kind !== 'char') {
          reject('invalid character class range (upper bound is not a single character)')
        }
        upper = resolution.value.codePointAt(0) ?? 0
      } else if (peek(cursor) === '[') {
        reject('invalid character class range (upper bound is a POSIX class)')
      } else {
        upper = consume(cursor).codePointAt(0) ?? 0
      }
      if (lower > upper) {
        reject(
          `invalid character class range (${prevChar}-${String.fromCodePoint(upper)} is reversed)`,
        )
      }
      items += 1
      prevChar = null
      continue
    }
    consume(cursor)
    items += 1
    prevChar = ch
  }
}

/** Parse `[:name:]` / `[:^name:]` with a strict POSIX name check. */
function parsePosixClass(cursor: Cursor): void {
  consume(cursor) // '['
  consume(cursor) // ':'
  let negated = false
  if (peek(cursor) === '^') {
    negated = true
    consume(cursor)
  }
  let name = ''
  while (!atEnd(cursor) && /[a-z]/.test(peek(cursor))) {
    name += consume(cursor)
  }
  if (!POSIX_CLASS_NAMES.has(name)) {
    reject(`unknown POSIX class name ([:${negated ? '^' : ''}${name}:])`)
  }
  if (peek(cursor) !== ':' || peek(cursor, 1) !== ']') {
    reject(`malformed POSIX class (expected [:${negated ? '^' : ''}${name}:])`)
  }
  consume(cursor)
  consume(cursor)
}

/** Parse `branch ('|' branch)*` at one group level. */
function parseAlternation(cursor: Cursor): void {
  parseBranch(cursor)
  while (peek(cursor) === '|') {
    consume(cursor)
    parseBranch(cursor)
  }
}

/**
 * Parse one alternation branch: a sequence of (possibly quantified) atoms.
 * `lastWasAtom` tracks whether the previous token is quantifiable — a
 * quantifier right after another quantifier, a zero-width token, or at a
 * branch start is RE2's "missing argument to repetition operator" error.
 */
function parseBranch(cursor: Cursor): void {
  let lastWasAtom = false
  for (;;) {
    if (atEnd(cursor)) return
    const ch = peek(cursor)
    if (ch === '|' || ch === ')') return
    if (ch === '*' || ch === '+' || ch === '?') {
      if (!lastWasAtom) reject('repetition operator with nothing to repeat')
      consumeQuantifier(cursor)
      lastWasAtom = false
      continue
    }
    if (ch === '{') {
      if (quantifierShapeAt(cursor)) {
        if (!lastWasAtom) reject('repetition operator with nothing to repeat')
        consumeQuantifier(cursor)
        lastWasAtom = false
      } else {
        consume(cursor) // literal `{`
        lastWasAtom = true
      }
      continue
    }
    const atom = parseAtom(cursor)
    lastWasAtom = atom.quantifiable
  }
}

/**
 * Check a `regex` rule pattern against the documented RE2 subset. Total:
 * never throws — every problem comes back as `{ valid: false, reason }`.
 */
export function checkRe2Pattern(pattern: string): Re2PatternCheck {
  // Total over anything a caller can hand over (the compile path pre-checks
  // the string type; a direct caller behind a broken cast must still get a
  // data outcome, never a TypeError).
  if (typeof pattern !== 'string') {
    return { valid: false, reason: 'pattern must be a string' }
  }
  if (pattern.includes('\u0000')) {
    return { valid: false, reason: 'pattern contains a NUL character' }
  }
  const cursor: Cursor = { src: pattern, at: 0, depth: 0 }
  try {
    parseAlternation(cursor)
    if (!atEnd(cursor)) {
      // The only way parseAlternation returns early is an unmatched ')'.
      reject('unbalanced parenthesis')
    }
    return { valid: true }
  } catch (error) {
    if (error instanceof PatternRejected) return { valid: false, reason: error.message }
    throw error // a checker bug is a bug — do not swallow it
  }
}
