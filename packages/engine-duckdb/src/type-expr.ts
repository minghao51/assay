// SPDX-License-Identifier: AGPL-3.0-or-later

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
 * reached DuckDB and executed. A second fix-round review then found the
 * *argument lists* of recognised types were still unvalidated: `DECIMAL(1,2,3)`,
 * `VARCHAR()`, `MAP(INTEGER)`, `STRUCT()`, `ENUM()` and friends shaped like
 * types but were malformed DuckDB, so they reached SQL type positions and
 * failed later with a binder error. This module is the single, total
 * validator: `parseEngineTypeExpression` either returns a canonical
 * `EngineTypeInfo` or throws a typed `EngineTypeError`; there is no
 * pass-through path.
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
 *   arg       := number                            -- DECIMAL(10,2), VARCHAR(10)
 *              | string                            -- ENUM('a','b') labels
 *              | type                              -- LIST(INTEGER), MAP(k, v)
 *              | fieldname type                    -- STRUCT/UNION members
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
 * **Argument shape (arity/modifier) validation** is type-aware, derived from
 * the pinned DuckDB CLI 1.5.5 (`/tmp/duckdb`). The closed set of
 * arity-validated spellings and the rules encoded for each:
 *
 * - `DECIMAL`/`NUMERIC`: bare, or exactly 1 or 2 **integer literals**;
 *   precision in `[1, 38]`, scale in `[0, precision]`. (CLI rejects
 *   `DECIMAL(1,2,3)` "at most two type modifiers", `DECIMAL(200)`/`DECIMAL(0)`
 *   "width must be between 1 and 38", and `DECIMAL(1,2)` "scale cannot be
 *   greater than width". Note: bare `DECIMAL()` is accepted by the 1.5.5 CLI
 *   as a default-precision spelling, but it is deliberately rejected here —
 *   the engine never emits it, and a fix-round finding requires the closed
 *   `p[,s]` arity, so the two spellings that *are* emitted (`DECIMAL` and
 *   `DECIMAL(p,s)`) both stay accepted.)
 * - `VARCHAR`/`CHAR`/`CHARACTER`/`BPCHAR`/`BIT`/`TEXT`/`STRING`/
 *   `NVARCHAR`/`FLOAT` and `TIME`/`TIMESTAMP`: bare, or exactly one integer
 *   modifier (`VARCHAR(10)`, `TIMESTAMP(3)`). `VARCHAR()`, `CHAR()`,
 *   `BIT()` and `TIMESTAMP(3,4)` are rejected. (`BPCHAR()` is accepted by the
 *   1.5.5 CLI but rejected here for the same closed-arity reason as
 *   `DECIMAL()`; the engine emits only the bare spelling.) The modifier value
 *   must be an integer literal the engine can **express**: `0..2147483647`.
 *   The 1.5.5 parser reads a type modifier as a signed 32-bit literal, so
 *   `VARCHAR(999999999999)` is a Parser Error, not a binder error — bounding
 *   the value here keeps that failure at validation instead of SQL
 *   composition. Negative values are unreachable through the grammar (the
 *   lexer rejects `-`). `CHARACTER VARYING` takes the modifier after
 *   `VARYING`.
 * - `LIST`: exactly one **type** argument (`LIST(INTEGER)`); `LIST`,
 *   `LIST()` and `LIST(INTEGER, VARCHAR)` are rejected.
 * - `MAP`: exactly two **type** arguments (`MAP(VARCHAR, INTEGER)`);
 *   `MAP(INTEGER)` and `MAP(VARCHAR, INTEGER, BIGINT)` are rejected.
 * - `STRUCT`/`UNION`: at least one `name type` member; `STRUCT()`,
 *   `STRUCT(INTEGER)` and `UNION()` are rejected.
 * - `ENUM`: at least one **string literal** (`ENUM('a','b')`); `ENUM()` and
 *   `ENUM(1)` are rejected.
 * - `T[]`/`T[n]` fixed-size arrays: the extent must be an unsigned integer
 *   `>= 1` (`INTEGER[0]` is rejected; `INTEGER[]` is the unbounded form).
 *
 * Everything else (an identifier this closed set does not name — `INTEGER`,
 * `DATE`, `UUID`, `JSON`, `TIMESTAMP_S`, `GEOMETRY`, …) takes the **permissive
 * identifier path**: it is accepted only as a plain identifier, with no
 * argument list, so `DATE(2)`/`INTEGER(3)`/`GEOMETRY('x')` are rejected even
 * though the path does not know the type's real grammar. Array suffixes are
 * always allowed (`INTEGER[]`, `GEOMETRY[]`) because the suffix is itself
 * structurally validated. This documents the closed set of arity-validated
 * spellings versus the permissive identifier path; the validator's job is to
 * prove "exactly one well-shaped type expression", not to re-implement
 * DuckDB's type catalog (the engine still rejects a genuinely unknown type
 * with its own readable binder error — never injection).
 *
 * Classification: `family` is the canonical string family the CSV
 * formula-injection guard keys off, and it is **shape-aware** — only a
 * *scalar* textual type is string-like. DuckDB reports every textual scalar
 * as `VARCHAR` in DESCRIBE, but an overlay's *declared* cast type or base
 * type may spell it `TEXT`, `STRING`, `CHAR(n)`, `BPCHAR`,
 * `CHARACTER [VARYING]`, `NVARCHAR`, or `ENUM(...)`; all of those render as
 * text and can be formula-shaped, so they classify as `'varchar'`. Arrays of
 * textual types (`VARCHAR[]`, `VARCHAR[3]`, `LIST(VARCHAR)`) deliberately do
 * **not**: the CSV guard must never apply scalar string functions (`left()`,
 * `contains()`) to an array value — the fix-round review caught exactly that
 * binder error. Every other type is `'other'`.
 */

/** A typed rejection of an engine type expression (never a pass-through). */
export class EngineTypeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EngineTypeError'
  }
}

/** Canonical family used by the CSV formula-injection guard / BLOB hex policy. */
export type EngineTypeFamily = 'varchar' | 'blob' | 'other'

/** Top-level shape: an array/list constructor versus a scalar type. */
export type EngineTypeShape = 'scalar' | 'array'

/** The validated shape of one engine type expression. */
export interface EngineTypeInfo {
  /** Uppercase base identifier (e.g. `VARCHAR`, `DECIMAL`, `STRUCT`, `LIST`). */
  readonly base: string
  /**
   * Canonical family of the type (`varchar` = a scalar that renders as text,
   * `blob` = a scalar binary whose raw CSV rendering is not text).
   */
  readonly family: EngineTypeFamily
  /**
   * `'array'` for `T[]`/`T[n]` and `LIST(...)`; `'scalar'` otherwise. The CSV
   * guard keys off `family`, which already folds this in — the field is
   * exposed so callers/tests can reason about top-level array shape directly.
   */
  readonly shape: EngineTypeShape
}

/**
 * Base identifiers whose values render as text and can therefore be
 * formula-shaped in a spreadsheet. `ENUM` renders its label; the rest are the
 * DuckDB textual aliases (all of which `DESCRIBE` canonicalizes to
 * `VARCHAR`, but which an overlay may declare verbatim). Only the **scalar**
 * form of any of these is `family: 'varchar'` (see `parseTypeExpression`).
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

/**
 * Binary base identifiers: DuckDB's CSV writer emits BLOB bytes **raw** (CLI
 * 1.5.5: `COPY (SELECT '=cmd|@SUM(1+1)'::BLOB …) TO … (FORMAT CSV)` writes a
 * live formula-leading cell), and the raw bytes cannot be handed to the
 * string guard's `contains`/`left` (BLOB is not text — `contains(BLOB,
 * VARCHAR)` is a Binder Error). The CSV exporter therefore **hex-encodes**
 * scalar BLOBs (`hex(x)`), an `[0-9A-F]`-only rendering that no spreadsheet
 * parser can read as a formula and that `from_hex` recovers losslessly.
 * `DESCRIBE` canonicalizes all four aliases to `blob` at 1.5.5; an overlay
 * may still declare them verbatim, so all four classify.
 */
const BLOB_FAMILY_BASES: ReadonlySet<string> = new Set(['BLOB', 'BYTEA', 'BINARY', 'VARBINARY'])

/** Multi-word continuations that must not be mistaken for a struct field name. */
const MULTI_WORD_CONTINUATIONS: ReadonlySet<string> = new Set([
  'WITH',
  'WITHOUT',
  'PRECISION',
  'VARYING',
])

/**
 * The largest optional-integer-modifier value the engine can express. DuckDB
 * 1.5.5 parses a type modifier as a signed 32-bit literal
 * (`SELECT 1::VARCHAR(999999999999)` → `Parser Error: syntax error at or near
 * "999999999999"`), while `VARCHAR(0)` and `VARCHAR(2147483647)` are accepted.
 * The validator refuses anything outside `0..MAX_TYPE_MODIFIER`, so an
 * inexpressible modifier fails at validation, never late at the engine.
 *
 * Carried limitation (deliberately **not** encoded here): individual types
 * have tighter real bounds this validator still does not model — e.g.
 * `TIMESTAMP(n)` accepts only `n` in `0..9` at the engine, so
 * `TIMESTAMP(10)` passes validation and is rejected by the binder.
 */
const MAX_TYPE_MODIFIER = 2_147_483_647

/** Types whose argument list is a single optional integer modifier. */
const OPTIONAL_INTEGER_MODIFIER_BASES: ReadonlySet<string> = new Set([
  'VARCHAR',
  'CHAR',
  'CHARACTER',
  'BPCHAR',
  'BIT',
  'VARBIT',
  'TEXT',
  'STRING',
  'NVARCHAR',
  'FLOAT',
  'TIME',
  'TIMESTAMP',
])

type Token =
  | { readonly kind: 'ident'; readonly value: string; readonly upper: string }
  | { readonly kind: 'number'; readonly value: string }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'quotedIdent'; readonly value: string }
  | { readonly kind: 'punct'; readonly value: '(' | ')' | '[' | ']' | ',' | '.' }

/** One parsed argument inside a type's `( … )` list. */
type ParsedArg =
  | { readonly kind: 'number'; readonly value: number }
  | { readonly kind: 'string' }
  | { readonly kind: 'type'; readonly info: EngineTypeInfo }
  | { readonly kind: 'field'; readonly name: string; readonly info: EngineTypeInfo }

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
    const info = this.parseTypeExpression()
    if (this.index < this.tokens.length) {
      throw new EngineTypeError('unexpected trailing token after a complete engine type expression')
    }
    return info
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

  /**
   * `primary array*`: parse the base identifier with its argument list and
   * multi-word suffix (validated for arity), then any number of array
   * suffixes. `LIST(...)` is itself an array constructor, so it also reports
   * `shape: 'array'`.
   */
  private parseTypeExpression(): EngineTypeInfo {
    const base = this.parsePrimary()
    let shape: EngineTypeShape = base === 'LIST' ? 'array' : 'scalar'
    while (this.isPunct('[')) {
      this.index += 1
      const extent = this.peek()
      if (extent !== undefined && extent.kind === 'number') {
        this.index += 1
        const size = Number(extent.value)
        if (!Number.isSafeInteger(size) || size < 1) {
          throw new EngineTypeError('fixed-size array extent must be at least 1')
        }
      } else if (extent !== undefined && extent.kind !== 'punct') {
        throw new EngineTypeError('array extent must be an unsigned integer')
      }
      this.expectPunct(']')
      shape = 'array'
    }
    return {
      base,
      shape,
      family:
        shape !== 'scalar'
          ? 'other'
          : STRING_FAMILY_BASES.has(base)
            ? 'varchar'
            : BLOB_FAMILY_BASES.has(base)
              ? 'blob'
              : 'other',
    }
  }

  /** Parse one base identifier, its argument list, suffix, and arity rules. */
  private parsePrimary(): string {
    const token = this.peek()
    if (token === undefined || token.kind !== 'ident') {
      throw new EngineTypeError('engine type expression must start with a type name')
    }
    this.index += 1
    const base = token.upper
    let args: readonly ParsedArg[] | undefined
    if (this.isPunct('(')) args = this.parseArgList()
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
        // The optional modifier of `CHARACTER VARYING` / `BIT VARYING`
        // follows `VARYING`; a modifier directly after the base was already
        // consumed above and is then a malformed double modifier.
        if (this.matchIdent('VARYING')) {
          if (this.isPunct('(')) {
            if (args !== undefined) {
              throw new EngineTypeError(`${base} VARYING has a duplicate type modifier`)
            }
            args = this.parseArgList()
          }
        }
        break
      default:
        break
    }
    this.validateArgumentShape(base, args)
    return base
  }

  /**
   * Parse a `( … )` argument list into typed arguments. An empty list is a
   * valid *parse* (returns `[]`); whether zero arguments is acceptable is the
   * arity rule's decision, so `VARCHAR()` and `DECIMAL()` reach their
   * validators rather than a generic syntax error.
   */
  private parseArgList(): ParsedArg[] {
    this.expectPunct('(')
    const args: ParsedArg[] = []
    if (this.isPunct(')')) {
      this.index += 1
      return args
    }
    for (;;) {
      args.push(this.parseArg())
      if (this.isPunct(',')) {
        this.index += 1
        continue
      }
      break
    }
    this.expectPunct(')')
    return args
  }

  private parseArg(): ParsedArg {
    const token = this.peek()
    if (token === undefined) {
      throw new EngineTypeError('unexpected end of engine type expression')
    }
    if (token.kind === 'number') {
      this.index += 1
      return { kind: 'number', value: Number(token.value) }
    }
    if (token.kind === 'string') {
      this.index += 1
      return { kind: 'string' }
    }
    if (token.kind === 'quotedIdent') {
      // A quoted name is always a STRUCT/UNION field name, never a bare type.
      this.index += 1
      return { kind: 'field', name: token.value, info: this.parseTypeExpression() }
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
      return { kind: 'field', name: token.value, info: this.parseTypeExpression() }
    }
    return { kind: 'type', info: this.parseTypeExpression() }
  }

  /**
   * Type-aware arity/modifier validation (see the module doc for the CLI
   * probes behind every rule). Types outside the closed set take the
   * permissive identifier path: no argument list is allowed.
   */
  private validateArgumentShape(base: string, args: readonly ParsedArg[] | undefined): void {
    switch (base) {
      case 'DECIMAL':
      case 'NUMERIC':
        this.validateDecimalModifiers(base, args)
        return
      case 'LIST':
        this.requireTypeArguments(base, args, 1)
        return
      case 'MAP':
        this.requireTypeArguments(base, args, 2)
        return
      case 'STRUCT':
      case 'UNION':
        this.requireFieldArguments(base, args)
        return
      case 'ENUM':
        this.requireStringArguments(base, args)
        return
      default:
        if (OPTIONAL_INTEGER_MODIFIER_BASES.has(base)) {
          this.requireOptionalIntegerModifier(base, args)
          return
        }
        if (args !== undefined) {
          throw new EngineTypeError(`engine type ${base} does not accept type parameters`)
        }
    }
  }

  private validateDecimalModifiers(base: string, args: readonly ParsedArg[] | undefined): void {
    if (args === undefined) return // bare DECIMAL/NUMERIC: default precision
    if (args.length < 1 || args.length > 2) {
      throw new EngineTypeError(`${base} takes only a precision and an optional scale`)
    }
    const precision = args[0]!
    if (precision.kind !== 'number') {
      throw new EngineTypeError(`${base} precision must be an integer literal`)
    }
    if (precision.value < 1 || precision.value > 38) {
      throw new EngineTypeError(`${base} precision must be between 1 and 38`)
    }
    const scale = args[1]
    if (scale === undefined) return
    if (scale.kind !== 'number') {
      throw new EngineTypeError(`${base} scale must be an integer literal`)
    }
    if (scale.value < 0 || scale.value > precision.value) {
      throw new EngineTypeError(`${base} scale must be between 0 and the precision`)
    }
  }

  private requireOptionalIntegerModifier(
    base: string,
    args: readonly ParsedArg[] | undefined,
  ): void {
    if (args === undefined) return
    const modifier = args[0]
    if (args.length !== 1 || modifier === undefined || modifier.kind !== 'number') {
      throw new EngineTypeError(`${base} takes at most one integer modifier`)
    }
    if (
      !Number.isInteger(modifier.value) ||
      modifier.value < 0 ||
      modifier.value > MAX_TYPE_MODIFIER
    ) {
      throw new EngineTypeError(
        `${base} modifier must be an integer between 0 and ${String(MAX_TYPE_MODIFIER)}`,
      )
    }
  }

  private requireTypeArguments(
    base: string,
    args: readonly ParsedArg[] | undefined,
    count: number,
  ): void {
    if (args === undefined || args.length !== count || args.some((arg) => arg.kind !== 'type')) {
      throw new EngineTypeError(
        `${base} requires exactly ${String(count)} type argument${count === 1 ? '' : 's'}`,
      )
    }
  }

  private requireFieldArguments(base: string, args: readonly ParsedArg[] | undefined): void {
    if (args === undefined || args.length < 1 || args.some((arg) => arg.kind !== 'field')) {
      throw new EngineTypeError(`${base} requires at least one "name type" member`)
    }
  }

  private requireStringArguments(base: string, args: readonly ParsedArg[] | undefined): void {
    if (args === undefined || args.length < 1 || args.some((arg) => arg.kind !== 'string')) {
      throw new EngineTypeError(`${base} requires at least one string label`)
    }
  }
}

/**
 * Validate one engine type expression as **exactly one complete DuckDB type**
 * and return its canonical base/family/shape. Throws `EngineTypeError` for
 * anything else — statement separators, comments, unbalanced brackets,
 * unterminated quotes, trailing tokens, empty input, disallowed characters,
 * or a malformed argument list (`DECIMAL(1,2,3)`, `VARCHAR()`, `MAP(INTEGER)`,
 * `STRUCT()`, `ENUM()`, …). The returned string is never used to rebuild SQL;
 * callers interpolate the already-validated original.
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
 * Whether a type expression is a **scalar** textual type that can be
 * formula-shaped — the CSV guard's classification. Shape-aware: `VARCHAR[]`,
 * `VARCHAR[3]` and `LIST(VARCHAR)` are arrays, not scalar strings, and are
 * deliberately `false` (the guard must never apply `left()`/`contains()` to a
 * list). Total: an invalid expression is `false` (composition validates
 * separately and reports the typed error).
 */
export function isStringLikeEngineType(text: unknown): boolean {
  try {
    return parseEngineTypeExpression(text).family === 'varchar'
  } catch {
    return false
  }
}

/**
 * Whether a type expression is a **scalar** DuckDB binary/BLOB alias — the
 * classification that drives the CSV exporter's lossless hex rendering (raw
 * BLOB bytes are a formula-injection bypass; see `BLOB_FAMILY_BASES`).
 * Shape-aware and total, mirroring {@link isStringLikeEngineType}: an array
 * of BLOBs or an invalid expression is `false`.
 */
export function isBlobLikeEngineType(text: unknown): boolean {
  try {
    const info = parseEngineTypeExpression(text)
    return info.shape === 'scalar' && info.family === 'blob'
  } catch {
    return false
  }
}
