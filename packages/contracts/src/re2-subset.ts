// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Conservative RE2-subset pattern check for JSON Schema `pattern` conversion
 * (m5-5) — **conversion-time dialect honesty**, self-contained in this pure
 * package.
 *
 * ## Why this lives here, and why it is not the authoritative check
 *
 * Contract v1 carries `regex` patterns verbatim and targets DuckDB's RE2
 * dialect. The **authoritative** RE2 judgment happens when a contract is
 * bound to a dataset — that checker lives in `@assay/validation` (m5-1), and
 * the dependency direction (`validation → contracts`) forbids importing it
 * here. This module is therefore a small, deliberately **conservative**
 * subset filter used at JSON Schema → contract conversion time, so the
 * *common* non-RE2 patterns are caught at import with a typed
 * unsupported-key error instead of surfacing later as binding errors.
 *
 * The honest division of labor (no silent approximation anywhere in the
 * chain):
 *
 * - a pattern this filter refuses → typed unsupported-key error at
 *   conversion; the schema author sees it immediately;
 * - a pattern this filter accepts is carried **verbatim** into the contract
 *   and later judged by m5-1's checker at binding time. The filter accepts
 *   only constructs m5-1's checker also accepts (it is strictly narrower),
 *   so a converted pattern failing m5-1 binding is possible only from drift
 *   between the packages — and would still surface as m5-1's typed binding
 *   error, never as a runtime surprise. This filter does not try to port
 *   m5-1's checker: duplicating it would only create a second thing to keep
 *   in sync.
 *
 * ## The dialect problem this filter actually decides
 *
 * JSON Schema's `pattern` dialect is ECMA-262 (annex-B in non-unicode mode);
 * contract `regex` semantics are RE2. Three situations are distinguishable,
 * and each gets its own treatment:
 *
 * 1. **Valid RE2, valid ECMA, same meaning** (`\d`, `\b`, `[A-Z]`, `a?`,
 *    `{2,4}`, `(?:…)`) → accepted.
 * 2. **Valid RE2, not valid ECMA** (`(?i)` flags, `a|` empty branch) →
 *    accepted: the contract rule's semantics *are* RE2's from the moment of
 *    conversion, so an RE2-only spelling converts honestly (it simply means
 *    the JSON Schema could never have been checked by a compliant JS
 *    validator — not our problem to litigate at conversion time).
 * 3. **Divergent readings, or absent from RE2** → refused: a spelling that
 *    matches the literal letter in ECMA but is an anchor in RE2 (`\A`, `\z`,
 *    `\a`), or is a construct RE2 has no equivalent for (lookarounds,
 *    backreferences, `\u`/`\c` escapes, ECMA's `(?<name>` groups) — carrying
 *    it would silently change what the rule enforces.
 *
 * Where RE2 and ECMA differ on an *accepted* construct's fine print (e.g.
 * `.` matches U+2028/U+2029 in ECMA but not in RE2), the RE2 meaning
 * governs — that is what "the contract rule is RE2-defined" means, and it is
 * why situation 2 is acceptable while situation 3 is not.
 *
 * ## Accepted subset (the whole list)
 *
 * - the empty pattern (valid RE2; matches everything)
 * - literal codepoints except NUL and the metacharacters `\ ( ) [ | * + ?`;
 *   `]` and `}` are literal outside classes; `{` is literal unless it forms
 *   a valid quantifier shape
 * - `.`, `^`, `$`, `|`; groups `(...)`, `(?:...)`, `(?P<name>...)` with name
 *   `[A-Za-z_][A-Za-z0-9_]*`, and flags groups `(?flags)` / `(?flags:...)`
 *   with a nonempty flag sequence from `i m s U` (no `-` negation — the
 *   filter accepts no negated flag forms; m5-1's stricter flag grammar is a
 *   superset)
 * - quantifiers `* + ? {n} {n,} {n,m}` with an optional lazy `?`; RE2's
 *   documented limits (`n,m ≤ 1000`, `n ≤ m`); only repeatable atoms
 *   quantify; possessive suffixes (`a*+`) are refused
 * - character classes `[...]`/`[^...]`: ranges between single characters
 *   (escaped characters allowed as endpoints; class shorthands are not
 *   endpoints), negation, a literal `-` at the edges; a `]` as the first
 *   member is a **literal** (ECMA-262 annex B and RE2 agree: `[]a]` matches
 *   `]` or `a`), while the empty classes `[]`/`[^]` are refused
 * - escapes: shorthands `\d \D \s \S \w \W` (in and out of classes);
 *   `\b \B` outside classes; controls `\n \t \r \f \v` (`\v` is the
 *   vertical tab in both ECMA-262 and RE2); any escaped **ASCII
 *   non-alphanumeric** character as a literal
 *
 * ## Refused (each with a stable, actionable reason)
 *
 * - lookarounds `(?= (?!` and the whole `(?<` family (lookbehinds, and
 *   ECMA-style named groups — RE2 spells named groups `(?P<name>`) and
 *   atomic groups `(?>…)`; possessive quantifiers (`a*+`)
 * - backreferences and decimal escapes: the whole `\0`–`\9` class (mirrors
 *   the m5-1 checker's documented stricter-than-DuckDB policy)
 * - divergent-reading letter escapes: `\A` `\z` (RE2 anchors vs ECMA literal
 *   letters — use `^`/`$`), `\a` (bell vs literal `a`), `\cX` (ECMA control
 *   escape vs no RE2 escape)
 * - `\u`/`\x` escapes (ECMA spellings; `\u` does not exist in RE2, and
 *   `\xHH` is refused by this filter as an exotic spelling — write the
 *   character itself), `\p{…}`/`\P{…}` Unicode classes, `\Q…\E`, `\Z`,
 *   `\K`, and any other letter escape; escaped non-ASCII codepoints (`\é` —
 *   invalid escape in RE2; the ECMA non-unicode reading, the literal
 *   character written without the backslash, is accepted)
 * - POSIX classes `[:name:]` (not part of ECMA-262 at all — a POSIX class in
 *   a JSON Schema pattern is more likely an authoring accident than intent;
 *   spell the ranges out)
 * - structural errors: unbalanced groups/classes, the empty classes
 *   `[]`/`[^]`, trailing backslash, reversed ranges, NUL anywhere
 * - group nesting deeper than {@link MAX_NESTING_DEPTH} — a filter-safety
 *   bound (recursive descent over the JS stack), not an RE2 rule; deeper
 *   patterns are refused as data rather than risking a stack-overflow throw
 *
 * Purity: pure string logic — no React, no browser APIs, no engine or
 * `@assay/*` imports.
 */

/** Outcome of checking one pattern; `reason` is stable, pin-able text. */
export type Re2SubsetCheck =
  { readonly valid: true } | { readonly valid: false; readonly reason: string }

/** RE2's documented repeat-count limit (RE2 and Go's regexp both enforce 1000). */
const MAX_REPEAT = 1000

/**
 * The deepest group nesting the filter walks (recursive descent over the JS
 * stack must never overflow into a throw). A pattern past the bound is
 * refused as data — the documented strictness asymmetry: a valid pattern
 * wrongly refused is a visible, actionable unsupported-key error.
 */
const MAX_NESTING_DEPTH = 100

/** Group-flag letters this filter accepts inside `(?…)` constructs. */
const FLAG_LETTERS: ReadonlySet<string> = new Set(['i', 'm', 's', 'U'])

/** Internal rejection signal; the public entry point turns it into data. */
class PatternRefused extends Error {}

function refuse(reason: string): never {
  throw new PatternRefused(reason)
}

/** Parser cursor over UTF-16 code units. */
interface Cursor {
  readonly src: string
  at: number
  /** Current `(...)` nesting depth (bounded by {@link MAX_NESTING_DEPTH}). */
  depth: number
}

/** What one escape resolves to: a single char, a class shorthand, or a zero-width anchor. */
type EscapeResolution =
  | { readonly kind: 'char'; readonly value: string }
  | { readonly kind: 'class' }
  | { readonly kind: 'zero' }

/** Parse one escape (cursor sits on the character after the backslash). */
function scanEscape(cursor: Cursor, inClass: boolean): EscapeResolution {
  const ch = cursor.src[cursor.at]
  if (ch === undefined) refuse('trailing backslash')
  cursor.at += 1
  if (ch >= '0' && ch <= '9') {
    refuse(
      "decimal escape \\0–\\9 is refused outright — \\1–\\9 are backreference escapes and RE2 has no backreferences, and \\0 would be RE2's octal escape (refused with the class, mirroring the binding-time checker)",
    )
  }
  if (ch.charCodeAt(0) > 0x7f) {
    refuse(
      `invalid escape \\${ch} — RE2 has no such escape; write the character without the backslash instead`,
    )
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
      if (inClass) refuse(`\\${ch} inside a character class is not RE2`)
      return { kind: 'zero' }
    case 'n':
      return { kind: 'char', value: '\n' }
    case 't':
      return { kind: 'char', value: '\t' }
    case 'r':
      return { kind: 'char', value: '\r' }
    case 'f':
      return { kind: 'char', value: '\f' }
    case 'a':
      return refuse(
        '\\a is refused — in RE2 it is the bell character but in ECMA-262 (the JSON Schema dialect) it reads as the literal letter "a"; write the character you mean',
      )
    case 'A':
      return refuse(
        '\\A is refused — in RE2 it is a start-of-text anchor but in ECMA-262 it reads as the literal letter "A"; use ^ instead',
      )
    case 'z':
      return refuse(
        '\\z is refused — in RE2 it is an end-of-text anchor but in ECMA-262 it reads as the literal letter "z"; use $ instead',
      )
    case 'v':
      // The vertical tab in both ECMA-262 and RE2 (DuckDB 1.5.5 accepts
      // `\v`); accepted here too (AR-V1).
      return { kind: 'char', value: '\u000b' }
    case 'c':
      return refuse(
        '\\c is refused — RE2 has no ECMA-style control escape; write the control character or a \\u-free spelling of it',
      )
    case 'x':
      return refuse(
        '\\xHH is refused by this conservative filter (write the character itself instead)',
      )
    case 'u':
      return refuse(
        '\\uHHHH is refused — RE2 has no \\u escape (write the character itself, or \\x-free spellings); convert by hand if you need an RE2 codepoint escape',
      )
    case 'p':
    case 'P':
      return refuse(
        `\\${ch} Unicode property/class escapes are not accepted by this filter (spell the characters out)`,
      )
    case 'Z':
      return refuse('\\Z is not RE2 (RE2 has \\z only)')
    case 'Q':
    case 'E':
      return refuse(
        '\\Q…\\E quoting is not accepted by this filter (escape the characters instead)',
      )
    default:
      if (/[A-Za-z]/.test(ch)) return refuse(`unsupported escape \\${ch}`)
      // Escaped ASCII non-alphanumeric (punctuation, space, …) is a literal
      // with the same meaning in ECMA-262 and RE2.
      return { kind: 'char', value: ch }
  }
}

/**
 * Does the `{` at the cursor start a valid quantifier shape (`{n}`, `{n,}`,
 * `{n,m}` — digits only)? Pure lookahead; enforces RE2's repeat limits.
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
  if (min > MAX_REPEAT) refuse(`repetition count ${min} exceeds the RE2 limit of ${MAX_REPEAT}`)
  if (max !== null) {
    if (max > MAX_REPEAT) refuse(`repetition count ${max} exceeds the RE2 limit of ${MAX_REPEAT}`)
    if (max < min) refuse(`repetition minimum ${min} exceeds maximum ${max}`)
  }
  return true
}

/** Consume a quantifier plus its optional lazy `?`, refusing possessive `+`. */
function consumeQuantifier(cursor: Cursor, startsWithBrace: boolean): void {
  if (startsWithBrace) {
    // quantifierShapeAt already validated a closing '}' exists ahead.
    cursor.at = cursor.src.indexOf('}', cursor.at) + 1
  } else {
    cursor.at += 1
  }
  if (cursor.src[cursor.at] === '?') cursor.at += 1 // lazy
  if (cursor.src[cursor.at] === '+') {
    refuse('possessive quantifier is not RE2 (remove the trailing +)')
  }
}

/** Parse one atom; returns whether it is quantifiable (anchors and flags directives are not). */
function scanAtom(cursor: Cursor): boolean {
  const ch = cursor.src[cursor.at] as string
  cursor.at += 1
  switch (ch) {
    case '^':
    case '$':
      return false
    case '.':
      return true
    case '[':
      scanClass(cursor)
      return true
    case '(':
      return scanGroup(cursor)
    case '\\': {
      const resolution = scanEscape(cursor, false)
      return resolution.kind !== 'zero'
    }
    default:
      return true // literal (including `]`, `}`, and non-quantifier-shaped `{` is handled by the caller)
  }
}

/**
 * Parse a `(...)`-group; returns whether it is quantifiable. The depth guard
 * keeps the recursive descent total (past the bound the pattern is refused
 * as data, never a stack-overflow throw).
 */
function scanGroup(cursor: Cursor): boolean {
  cursor.depth += 1
  if (cursor.depth > MAX_NESTING_DEPTH) {
    refuse(
      `pattern nests groups more than ${MAX_NESTING_DEPTH} deep (this filter's documented nesting bound — deep patterns are refused as data, not walked)`,
    )
  }
  try {
    const ch = cursor.src[cursor.at]
    if (ch === undefined) refuse('unbalanced parenthesis')
    if (ch !== '?') {
      scanAlternation(cursor)
      expectGroupClose(cursor)
      return true
    }
    cursor.at += 1
    const kind = cursor.src[cursor.at]
    if (kind === undefined) refuse('unbalanced parenthesis')
    if (kind === ':') {
      cursor.at += 1
      scanAlternation(cursor)
      expectGroupClose(cursor)
      return true
    }
    if (kind === 'P') {
      cursor.at += 1
      if (cursor.src[cursor.at] !== '<') refuse('malformed (?P… group (expected (?P<name>))')
      cursor.at += 1
      scanGroupName(cursor)
      if (cursor.src[cursor.at] !== '>') refuse('unterminated (?P<name> group')
      cursor.at += 1
      scanAlternation(cursor)
      expectGroupClose(cursor)
      return true
    }
    if (kind === '=' || kind === '!') {
      refuse('lookaround ((?=…), (?!…)) is not RE2')
    }
    if (kind === '<') {
      refuse(
        '(?<… is refused — lookbehind ((?<=, (?<!) is not RE2, and ECMA-style (?<name> groups must be spelled (?P<name> for RE2',
      )
    }
    if (kind === '>') {
      refuse('atomic groups ((?>…)) are not RE2')
    }
    // Flags group: a nonempty run of `i m s U` letters, then ')' or ':'.
    // No '-' negation is accepted by this filter (m5-1's flag grammar, which
    // allows one negation, is a superset).
    let flags = 0
    for (;;) {
      if (FLAG_LETTERS.has(cursor.src[cursor.at] ?? '')) {
        flags += 1
        cursor.at += 1
      } else break
      if (cursor.src[cursor.at] === undefined) refuse('unbalanced parenthesis')
    }
    if (flags === 0) {
      refuse(
        `unsupported group syntax (?${kind}… — supported: (…), (?:…), (?P<name>…), (?flags…) and (?flags:…) with flags i m s U`,
      )
    }
    if (cursor.src[cursor.at] === ')') {
      cursor.at += 1
      return false // a flags directive matches nothing
    }
    if (cursor.src[cursor.at] === ':') {
      cursor.at += 1
      scanAlternation(cursor)
      expectGroupClose(cursor)
      return true
    }
    refuse(
      `unsupported group syntax (?…${cursor.src[cursor.at] ?? ''} — expected flag letters from i m s U, then ')' or ':'`,
    )
  } finally {
    cursor.depth -= 1
  }
}

function expectGroupClose(cursor: Cursor): void {
  if (cursor.src[cursor.at] !== ')') refuse('unbalanced parenthesis')
  cursor.at += 1
}

/** Parse a named-group identifier: `[A-Za-z_][A-Za-z0-9_]*` (strict). */
function scanGroupName(cursor: Cursor): void {
  let length = 0
  while (/[A-Za-z0-9_]/.test(cursor.src[cursor.at + length] ?? '')) length += 1
  const name = cursor.src.slice(cursor.at, cursor.at + length)
  cursor.at += length
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    refuse(`invalid capture-group name (${JSON.stringify(name)})`)
  }
}

/**
 * Parse a `[...]` character class (cursor sits just past `[`). A `]` as the
 * very first member (after an optional `^`) is a literal — ECMA-262 annex B
 * (the JSON Schema dialect) and RE2 agree (`[]a]` matches `]` or `a`),
 * mirroring the binding-time checker. The empty classes `[]`/`[^]` remain
 * refused (both dialects reject them).
 */
function scanClass(cursor: Cursor): void {
  if (cursor.src[cursor.at] === '^') cursor.at += 1
  let items = 0
  // The previous item when it was a single character — the only legal lower
  // bound of a range. Class-shorthand items clear it.
  let prevChar: string | null = null
  for (;;) {
    const ch = cursor.src[cursor.at]
    if (ch === undefined) refuse('unterminated character class')
    if (items === 0 && ch === ']') {
      // Leading `]` is a literal member; `[]` falls through to the
      // unterminated-class error on the next iteration.
      cursor.at += 1
      items += 1
      prevChar = ']'
      continue
    }
    if (ch === ']') {
      cursor.at += 1
      return
    }
    if (ch === '[' && cursor.src[cursor.at + 1] === ':') {
      refuse('POSIX classes ([:…:]) are refused by this conservative filter — spell the ranges out')
    }
    if (ch === '\\') {
      cursor.at += 1
      const resolution = scanEscape(cursor, true)
      prevChar = resolution.kind === 'char' ? resolution.value : null
      items += 1
      continue
    }
    if (
      ch === '-' &&
      prevChar !== null &&
      cursor.src[cursor.at + 1] !== undefined &&
      cursor.src[cursor.at + 1] !== ']'
    ) {
      cursor.at += 1 // '-'
      if (cursor.src[cursor.at] === '[') {
        refuse('invalid character class range (upper bound is a POSIX class)')
      }
      const lower = prevChar.codePointAt(0) ?? 0
      let upper: number
      if (cursor.src[cursor.at] === '\\') {
        cursor.at += 1
        const resolution = scanEscape(cursor, true)
        if (resolution.kind !== 'char') {
          refuse('invalid character class range (upper bound is not a single character)')
        }
        upper = resolution.kind === 'char' ? (resolution.value.codePointAt(0) ?? 0) : 0
      } else {
        upper = (cursor.src[cursor.at] as string).codePointAt(0) ?? 0
        cursor.at += 1
      }
      if (lower > upper) {
        refuse(
          `invalid character class range (${prevChar}-${String.fromCodePoint(upper)} is reversed)`,
        )
      }
      items += 1
      prevChar = null
      continue
    }
    cursor.at += 1
    items += 1
    prevChar = ch
  }
}

/** Parse `branch ('|' branch)*` at one group level. */
function scanAlternation(cursor: Cursor): void {
  scanBranch(cursor)
  while (cursor.src[cursor.at] === '|') {
    cursor.at += 1
    scanBranch(cursor)
  }
}

/**
 * Parse one alternation branch: a sequence of (possibly quantified) atoms.
 * `lastWasAtom` tracks whether the previous token is quantifiable — a
 * quantifier directly after another quantifier, a zero-width token, or at a
 * branch start has nothing to repeat.
 */
function scanBranch(cursor: Cursor): void {
  let lastWasAtom = false
  for (;;) {
    const ch = cursor.src[cursor.at]
    if (ch === undefined || ch === '|' || ch === ')') return
    if (ch === '*' || ch === '+' || ch === '?') {
      if (!lastWasAtom) refuse('repetition operator with nothing to repeat')
      consumeQuantifier(cursor, false)
      lastWasAtom = false
      continue
    }
    if (ch === '{') {
      if (quantifierShapeAt(cursor)) {
        if (!lastWasAtom) refuse('repetition operator with nothing to repeat')
        consumeQuantifier(cursor, true)
        lastWasAtom = false
      } else {
        cursor.at += 1 // literal `{`
        lastWasAtom = true
      }
      continue
    }
    lastWasAtom = scanAtom(cursor)
  }
}

/**
 * Check a JSON Schema `pattern` against the documented conservative RE2
 * subset. Total: never throws — every problem comes back as
 * `{ valid: false, reason }`. Deliberately narrower than the binding-time
 * checker in `@assay/validation` (see the module doc for the division of
 * labor).
 */
export function checkRe2SubsetPattern(pattern: string): Re2SubsetCheck {
  // Total over anything a caller can hand over (the adapter pre-checks the
  // string type; a direct caller behind a broken cast must still get a data
  // outcome, never a TypeError).
  if (typeof pattern !== 'string') {
    return { valid: false, reason: 'pattern must be a string' }
  }
  if (pattern.includes('\u0000')) {
    return { valid: false, reason: 'pattern contains a NUL character' }
  }
  const cursor: Cursor = { src: pattern, at: 0, depth: 0 }
  try {
    scanAlternation(cursor)
    if (cursor.at < pattern.length) {
      // The only way scanAlternation returns early is an unmatched ')'.
      refuse('unbalanced parenthesis')
    }
    return { valid: true }
  } catch (error) {
    if (error instanceof PatternRefused) return { valid: false, reason: error.message }
    throw error // a checker bug is a bug — do not swallow it
  }
}
