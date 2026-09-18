/**
 * Strict validation and canonical classification of DuckDB type expressions
 * (m4-2 fix round).
 *
 * Type strings are **untrusted input**: they arrive from the host as
 * `OverlayBase.columns[].type` and `column-cast.targetType`, and the overlay
 * composer interpolates them into SQL type positions (`CAST(x AS <type>)`).
 * A validator is therefore the only thing standing between a hostile host and
 * statement injection. The m4-2 review found the boundary accepted arbitrary
 * strings and a payload
 * `VARCHAR) AS "c" FROM (...) ); CREATE TABLE assay_injected AS SELECT 31337; --`
 * reached DuckDB and executed. This module is the single, total validator:
 * `parseEngineTypeExpression` either returns a canonical `EngineTypeInfo` or
 * throws a typed `EngineTypeError`; there is no pass-through path.
 *
 * Grammar enforced — exactly one complete type expression, then EOF:
 *
 *   type      := primary array*
 *   array     := '[' [digits] ']'                  -- INTEGER[], VARCHAR[3]
 *   primary   := IDENT ['(' arglist ')'] suffix
 *   suffix    := 'WITH' 'TIME' 'ZONE'              -- TIMESTAMP/TIME
 *              | 'WITHOUT' 'TIME' 'ZONE'
 *              | 'PRECISION'                       -- DOUBLE PRECISION
 *              | 'VARYING' ['(' arglist ')']       -- CHARACTER/BIT VARYING
 *   arglist   := arg (',' arg)*
 *   arg       := type
 *              | fieldname type                    -- STRUCT/UNION members
 *              | number                            -- DECIMAL(10,2), VARCHAR(10)
 *              | string                            -- ENUM('a','b') labels
 *   fieldname := IDENT | QUOTED_IDENT
 *
 * Lexer allowlist: identifiers (`[A-Za-z_][A-Za-z0-9_]*`), unsigned integers,
 * single-quoted string literals with `''` escapes, double-quoted identifiers
 * with `""` escapes, the punctuation `( ) [ ] , .` and whitespace. Every other
 * character — crucially `;`, `-`, `/`, `*`, `\`, `&`, `|`, `%` — is rejected
 * at the lexer, so `--` line comments, block comments, statement separators, and
 * operators cannot appear at all. Brackets must balance and the parse must
 * consume the whole input, so trailing tokens (`VARCHAR foo`) and injected
 * closers (`VARCHAR)`) are `EngineTypeError`s.
 *
 * Accept set: the type space DuckDB can emit or accept, including the m4-2
 * review checklist — `VARCHAR`, `VARCHAR(10)`, `TEXT`, `STRING`, `CHAR(2)`,
 * `BPCHAR`, `CHARACTER [VARYING]`, the integer families (`INTEGER`…`UBIGINT`,
 * `HUGEINT`), `FLOAT`/`REAL`/`DOUBLE [PRECISION]`, `DECIMAL(p,s)` /
 * `NUMERIC(p,s)`, `BOOLEAN`, `BLOB`/`BYTEA`, `DATE`, `TIME`/`TIMESTAMP`
 * `[WITH|WITHOUT TIME ZONE]`, `TIMESTAMPTZ`, `INTERVAL`, `UUID`, `JSON`,
 * `INTEGER[]`, `LIST(INTEGER)`, `VARCHAR[3]`, `STRUCT(name type, …)`,
 * `MAP(k, v)`, `UNION(name type, …)`, `ENUM('a','b')`, and nested
 * combinations. Unknown identifiers are accepted as long as they are a single
 * well-formed type-shaped token sequence: the validator's job is to prove
 * "exactly one type expression", not to re-implement DuckDB's type catalog
 * (the engine still rejects a genuinely unknown type with its own binder
 * error — a readable typed failure, never injection).
 *
 * Classification: `family` is the canonical string family the CSV
 * formula-injection guard keys off. DuckDB reports every textual scalar as
 * `VARCHAR` in DESCRIBE, but an overlay's *declared* cast type or base type
 * may spell it `TEXT`, `STRING`, `CHAR(n)`, `BPCHAR`, `CHARACTER [VARYING]`,
 * or `ENUM(...)`. All of those render as text and can be formula-shaped, so
 * they classify as `'varchar'`; every other type is `'other'`. Matching the
 * declared spelling (rather than the DESCRIBE output) is exactly the m4-2
 * review's CSV finding: an exact-`'VARCHAR'` check missed a `TEXT` cast.
 */

/** A typed rejection of an engine type expression (never a pass-through). */
export class EngineTypeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EngineTypeError'
  }
}

/** Canonical string family used by the CSV formula-injection guard. */
export type EngineTypeFamily = 'varchar' | 'other'

/** The validated shape of one engine type expression. */
export interface EngineTypeInfo {
  /** Uppercase base identifier (e.g. `VARCHAR`, `DECIMAL`, `STRUCT`). */
  readonly base: string
  /** Canonical family of the type (`varchar` = renders as text). */
  readonly family: EngineTypeFamily
}

/**
 * Base identifiers whose values render as text and can therefore be
 * formula-shaped in a spreadsheet. `ENUM` renders its label; the rest are the
 * DuckDB textual aliases (all of which `DESCRIBE` canonicalizes to
 * `VARCHAR`, but which an overlay may declare verbatim).
 */
const STRING_FAMILY_BASES: ReadonlySet<string> = new Set([
  'VARCHAR',
  'TEXT',
  'STRING',
  'CHAR',
  'CHARACTER',
  'BPCHAR',
  'NVARCHAR',
  'ENUM',
])

/** Multi-word continuations that must not be mistaken for a struct field name. */
const MULTI_WORD_CONTINUATIONS: ReadonlySet<string> = new Set([
  'WITH',
  'WITHOUT',
  'PRECISION',
  'VARYING',
])

type Token =
  | { readonly kind: 'ident'; readonly value: string; readonly upper: string }
  | { readonly kind: 'number'; readonly value: string }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'quotedIdent'; readonly value: string }
  | { readonly kind: 'punct'; readonly value: '(' | ')' | '[' | ']' | ',' | '.' }

const IDENT_START = /[A-Za-z_]/
const IDENT_PART = /[A-Za-z0-9_]/
const DIGIT = /[0-9]/
const WHITESPACE = /[ \t\n\r\f\v]/

/**
 * Tokenize a type expression against the allowlist. Throws `EngineTypeError`
 * on the first disallowed character or unterminated quote; never returns a
 * partial stream.
 */
function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  while (index < input.length) {
    const character = input[index]!
    if (WHITESPACE.test(character)) {
      index += 1
      continue
    }
    if (character === "'") {
      const [value, next] = readQuoted(input, index, "'", 'string literal')
      tokens.push({ kind: 'string', value })
      index = next
      continue
    }
    if (character === '"') {
      const [value, next] = readQuoted(input, index, '"', 'quoted identifier')
      tokens.push({ kind: 'quotedIdent', value })
      index = next
      continue
    }
    if (IDENT_START.test(character)) {
      let end = index + 1
      while (end < input.length && IDENT_PART.test(input[end]!)) end += 1
      const value = input.slice(index, end)
      tokens.push({ kind: 'ident', value, upper: value.toUpperCase() })
      index = end
      continue
    }
    if (DIGIT.test(character)) {
      let end = index + 1
      while (end < input.length && DIGIT.test(input[end]!)) end += 1
      tokens.push({ kind: 'number', value: input.slice(index, end) })
      index = end
      continue
    }
    if (
      character === '(' ||
      character === ')' ||
      character === '[' ||
      character === ']' ||
      character === ',' ||
      character === '.'
    ) {
      tokens.push({ kind: 'punct', value: character })
      index += 1
      continue
    }
    throw new EngineTypeError(
      `engine type expression contains a disallowed character at position ${String(index)}`,
    )
  }
  return tokens
}

/** Read a `'…'`/`"…"` quoted run with doubled-quote escapes. */
function readQuoted(
  input: string,
  start: number,
  quote: "'" | '"',
  what: string,
): [value: string, next: number] {
  let index = start + 1
  let value = ''
  while (index < input.length) {
    const character = input[index]!
    if (character === quote) {
      if (input[index + 1] === quote) {
        value += quote
        index += 2
        continue
      }
      return [value, index + 1]
    }
    value += character
    index += 1
  }
  throw new EngineTypeError(`unterminated ${what} in engine type expression`)
}

/**
 * Recursive-descent parser over the token stream. Every failure is a typed
 * `EngineTypeError`; `index` only advances past tokens already consumed, so a
 * failure never yields a partially-built expression.
 */
class TypeExpressionParser {
  private index = 0

  constructor(private readonly tokens: readonly Token[]) {}

  /** Parse one complete type expression; reject trailing tokens. */
  parse(): EngineTypeInfo {
    if (this.tokens.length === 0) {
      throw new EngineTypeError('empty engine type expression')
    }
    const base = this.parseType()
    if (this.index < this.tokens.length) {
      throw new EngineTypeError('unexpected trailing token after a complete engine type expression')
    }
    return {
      base,
      family: STRING_FAMILY_BASES.has(base) ? 'varchar' : 'other',
    }
  }

  private peek(): Token | undefined {
    return this.tokens[this.index]
  }

  private isPunct(value: string): boolean {
    const token = this.peek()
    return token !== undefined && token.kind === 'punct' && token.value === value
  }

  private expectPunct(value: '(' | ')' | '[' | ']' | ',' | '.'): void {
    if (!this.isPunct(value)) {
      throw new EngineTypeError(`expected "${value}" in engine type expression`)
    }
    this.index += 1
  }

  private expectIdent(value: string): void {
    const token = this.peek()
    if (token === undefined || token.kind !== 'ident' || token.upper !== value) {
      throw new EngineTypeError(`expected ${value} in engine type expression`)
    }
    this.index += 1
  }

  private matchIdent(value: string): boolean {
    const token = this.peek()
    if (token !== undefined && token.kind === 'ident' && token.upper === value) {
      this.index += 1
      return true
    }
    return false
  }

  private parseType(): string {
    const base = this.parsePrimary()
    while (this.isPunct('[')) {
      this.index += 1
      if (this.peek()?.kind === 'number') this.index += 1
      this.expectPunct(']')
    }
    return base
  }

  private parsePrimary(): string {
    const token = this.peek()
    if (token === undefined || token.kind !== 'ident') {
      throw new EngineTypeError('engine type expression must start with a type name')
    }
    this.index += 1
    const base = token.upper
    if (this.isPunct('(')) this.parseArgList()
    switch (base) {
      case 'TIMESTAMP':
      case 'TIME': {
        const next = this.peek()
        if (
          next !== undefined &&
          next.kind === 'ident' &&
          (next.upper === 'WITH' || next.upper === 'WITHOUT')
        ) {
          this.index += 1
          this.expectIdent('TIME')
          this.expectIdent('ZONE')
        }
        break
      }
      case 'DOUBLE':
        this.matchIdent('PRECISION')
        break
      case 'CHARACTER':
      case 'BIT':
        if (this.matchIdent('VARYING') && this.isPunct('(')) this.parseArgList()
        break
      default:
        break
    }
    return base
  }

  private parseArgList(): void {
    this.expectPunct('(')
    if (this.isPunct(')')) {
      this.index += 1
      return
    }
    for (;;) {
      this.parseArg()
      if (this.isPunct(',')) {
        this.index += 1
        continue
      }
      break
    }
    this.expectPunct(')')
  }

  private parseArg(): void {
    const token = this.peek()
    if (token === undefined) {
      throw new EngineTypeError('unexpected end of engine type expression')
    }
    if (token.kind === 'number' || token.kind === 'string') {
      this.index += 1
      return
    }
    if (token.kind === 'quotedIdent') {
      // A quoted name is always a STRUCT/UNION field name, never a bare type.
      this.index += 1
      this.parseType()
      return
    }
    // `fieldname type` (STRUCT/UNION) vs a bare type argument. A following
    // identifier is a field name unless it continues a multi-word type name
    // (`TIMESTAMP WITH …`, `DOUBLE PRECISION`, `CHARACTER VARYING`).
    const next = this.tokens[this.index + 1]
    if (
      next !== undefined &&
      (next.kind === 'ident' || next.kind === 'quotedIdent') &&
      !(next.kind === 'ident' && MULTI_WORD_CONTINUATIONS.has(next.upper))
    ) {
      this.index += 1
      this.parseType()
      return
    }
    this.parseType()
  }
}

/**
 * Validate one engine type expression as **exactly one complete DuckDB type**
 * and return its canonical base/family. Throws `EngineTypeError` for anything
 * else — statement separators, comments, unbalanced brackets, unterminated
 * quotes, trailing tokens, empty input, or disallowed characters. The
 * returned string is never used to rebuild SQL; callers interpolate the
 * already-validated original.
 */
export function parseEngineTypeExpression(text: unknown): EngineTypeInfo {
  if (typeof text !== 'string') {
    throw new EngineTypeError('engine type expression must be a string')
  }
  return new TypeExpressionParser(tokenize(text)).parse()
}

/** Validate a type expression for its side effect (throws `EngineTypeError`). */
export function validateEngineTypeExpression(text: unknown): void {
  parseEngineTypeExpression(text)
}

/**
 * Whether a type expression renders as text and can be formula-shaped —
 * the CSV guard's classification. Total: an invalid expression is `false`
 * (composition validates separately and reports the typed error).
 */
export function isStringLikeEngineType(text: unknown): boolean {
  try {
    return parseEngineTypeExpression(text).family === 'varchar'
  } catch {
    return false
  }
}
