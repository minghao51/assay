// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * DuckDB type-string parser (m1-6).
 *
 * The engine's `schema()` passes DuckDB's DESCRIBE `column_type` strings
 * through unchanged (m1-4), e.g.:
 *
 *   STRUCT("name" VARCHAR, geo STRUCT(lat DECIMAL(21,1), lon DECIMAL(21,1)),
 *          tags VARCHAR[], scores STRUCT(q1 DOUBLE, q2 INTEGER))
 *
 * This module turns such strings into a navigable tree for the schema panel.
 * It is a recursive-descent parser over the grammar DuckDB actually prints:
 *
 *   type    := primary arraySuffix
 *   primary := STRUCT(field,…)
 *            | UNION(field,…)          (tagged alternatives, struct-shaped)
 *            | LIST(type)
 *            | MAP(type, type)
 *            | IDENT params? …         (parameterized primitives: DECIMAL(21,1);
 *                                       multi-word names: TIMESTAMP WITH TIME ZONE)
 *            | "quoted name" | 'string' | number   (degrade to leaf labels)
 *   field   := (IDENT | "quoted" | 'string') type
 *   arraySuffix := ('[' digits? ']')*        (VARCHAR[], INT[2][3], STRUCT(x INT)[])
 *
 * Degradation strategy (total function): `parseDuckDbType` never throws. Any
 * input it cannot fully fit into the grammar — future/unknown types, unbalanced
 * delimiters, trailing garbage, empty strings — degrades to a single
 * `{ kind: 'unknown', raw }` leaf that the UI can still display verbatim.
 * Parameter lists of non-structural types are captured as raw text, so
 * parameterized primitives never need per-type knowledge.
 */

/** One field of a STRUCT or UNION type. */
export interface DuckDbField {
  readonly name: string
  readonly type: DuckDbType
}

/**
 * Parsed DuckDB type tree. `unknown` is the graceful-degradation leaf: its
 * `raw` text is whatever could not be parsed, shown to the user as-is.
 */
export type DuckDbType =
  | { readonly kind: 'primitive'; readonly label: string }
  | { readonly kind: 'struct'; readonly fields: readonly DuckDbField[] }
  | { readonly kind: 'union'; readonly fields: readonly DuckDbField[] }
  | { readonly kind: 'list'; readonly element: DuckDbType; readonly dimensions: string }
  | { readonly kind: 'map'; readonly key: DuckDbType; readonly value: DuckDbType }
  | { readonly kind: 'unknown'; readonly raw: string }

/** Raised internally on any grammar violation; `parseDuckDbType` catches it. */
class TypeParseError extends Error {
  constructor(detail: string) {
    super(detail)
    this.name = 'TypeParseError'
  }
}

type Token =
  | { readonly kind: 'ident'; readonly text: string }
  | { readonly kind: 'quoted'; readonly text: string } // "..." with "" escapes
  | { readonly kind: 'string'; readonly text: string } // '...' with '' escapes
  | { readonly kind: 'number'; readonly text: string }
  | { readonly kind: 'punct'; readonly text: string } // one of ( ) [ ] ,
  | { readonly kind: 'other'; readonly text: string } // anything else → parse error

function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  while (index < input.length) {
    const char = input[index]!
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      index++
      continue
    }
    if (char === '"' || char === "'") {
      const quote = char
      let text = ''
      index++
      for (;;) {
        if (index >= input.length) throw new TypeParseError('unterminated quoted name')
        const c = input[index]!
        if (c === quote) {
          if (input[index + 1] === quote) {
            text += quote // doubled quote is an escaped quote
            index += 2
            continue
          }
          index++
          break
        }
        text += c
        index++
      }
      tokens.push({ kind: quote === '"' ? 'quoted' : 'string', text })
      continue
    }
    if (/[0-9]/.test(char)) {
      let text = ''
      while (index < input.length && /[0-9]/.test(input[index]!)) {
        text += input[index]!
        index++
      }
      tokens.push({ kind: 'number', text })
      continue
    }
    if (/[A-Za-z_]/.test(char)) {
      let text = ''
      while (index < input.length && /[A-Za-z0-9_]/.test(input[index]!)) {
        text += input[index]!
        index++
      }
      tokens.push({ kind: 'ident', text })
      continue
    }
    if (char === '(' || char === ')' || char === '[' || char === ']' || char === ',') {
      tokens.push({ kind: 'punct', text: char })
      index++
      continue
    }
    tokens.push({ kind: 'other', text: char })
    index++
  }
  return tokens
}

/** Types DuckDB prints with structural (non-opaque) parameter lists. */
const STRUCTURAL_KEYWORDS = { struct: true, union: true, list: true, map: true } as const

/**
 * Multi-word primitive continuations (case-insensitive). Joining is limited
 * to this list so malformed field lists (`a VARCHAR b INTEGER`) fail the
 * grammar and degrade to `unknown` instead of silently merging field types.
 */
const MULTI_WORD_CONTINUATIONS: readonly (readonly string[])[] = [
  ['WITH', 'TIME', 'ZONE'],
  ['WITHOUT', 'TIME', 'ZONE'],
  ['PRECISION'],
]

class TypeParser {
  private position = 0

  private constructor(private readonly tokens: readonly Token[]) {}

  static parse(input: string): DuckDbType {
    const parser = new TypeParser(tokenize(input))
    const type = parser.parseType()
    if (parser.position !== parser.tokens.length) {
      throw new TypeParseError('trailing tokens after type')
    }
    return type
  }

  private peek(): Token | undefined {
    return this.tokens[this.position]
  }

  private next(): Token {
    const token = this.tokens[this.position]
    if (token === undefined) throw new TypeParseError('unexpected end of type string')
    this.position++
    return token
  }

  private peekPunct(text: string): boolean {
    const token = this.peek()
    return token !== undefined && token.kind === 'punct' && token.text === text
  }

  private expectPunct(text: string): void {
    const token = this.next()
    if (token.kind !== 'punct' || token.text !== text) {
      throw new TypeParseError(`expected '${text}', got ${JSON.stringify(token.text)}`)
    }
  }

  private parseType(): DuckDbType {
    const base = this.parsePrimary()
    return this.parseArraySuffix(base)
  }

  /** `T[]`, `T[5]`, `T[2][3]` — zero or more fixed/variable dimensions. */
  private parseArraySuffix(base: DuckDbType): DuckDbType {
    let dimensions = ''
    while (this.peekPunct('[')) {
      this.next()
      let size = ''
      const token = this.peek()
      if (token !== undefined && token.kind === 'number') {
        size = token.text
        this.next()
      }
      this.expectPunct(']')
      dimensions += `[${size}]`
    }
    return dimensions === '' ? base : { kind: 'list', element: base, dimensions }
  }

  private parsePrimary(): DuckDbType {
    const token = this.peek()
    if (token === undefined) throw new TypeParseError('empty type')

    // Quoted names / strings / numbers at type position degrade to leaf
    // labels rather than failing — they are valid (if unusual) type names.
    if (token.kind === 'quoted' || token.kind === 'string' || token.kind === 'number') {
      this.next()
      return { kind: 'primitive', label: token.text }
    }
    if (token.kind === 'other') {
      throw new TypeParseError(`unexpected character ${JSON.stringify(token.text)}`)
    }
    if (token.kind !== 'ident') {
      throw new TypeParseError(`expected a type name, got ${JSON.stringify(token.text)}`)
    }
    this.next()
    const word = token.text.toUpperCase()
    if (word.toLowerCase() in STRUCTURAL_KEYWORDS && this.peekPunct('(')) {
      switch (word) {
        case 'STRUCT':
          return this.parseFields('struct')
        case 'UNION':
          return this.parseFields('union')
        case 'LIST': {
          this.expectPunct('(')
          const element = this.parseType()
          this.expectPunct(')')
          return { kind: 'list', element, dimensions: '' }
        }
        case 'MAP': {
          this.expectPunct('(')
          const key = this.parseType()
          this.expectPunct(',')
          const value = this.parseType()
          this.expectPunct(')')
          return { kind: 'map', key, value }
        }
      }
    }

    // Non-structural identifier: capture parenthesized parameter lists as raw
    // text (DECIMAL(21,1)) and join only known multi-word names (TIMESTAMP
    // WITH TIME ZONE) — opaque leaves need no per-type knowledge.
    let label = token.text
    for (;;) {
      if (this.peekPunct('(')) {
        label += this.captureRawParenGroup()
        continue
      }
      const continuation = this.matchMultiWordContinuation()
      if (continuation === null) break
      label += continuation
    }
    return { kind: 'primitive', label }
  }

  /** If the upcoming tokens are a known multi-word continuation, consume and return them. */
  private matchMultiWordContinuation(): string | null {
    for (const words of MULTI_WORD_CONTINUATIONS) {
      const start = this.position
      let joined = ''
      let matched = true
      for (const word of words) {
        const token = this.tokens[this.position]
        if (token === undefined || token.kind !== 'ident' || token.text.toUpperCase() !== word) {
          matched = false
          break
        }
        joined += ` ${token.text}`
        this.position++
      }
      if (matched) return joined
      this.position = start
    }
    return null
  }

  /**
   * Consume a balanced `(...)` group verbatim (caller has peeked the `(`).
   * Contents are not interpreted: params of primitives are scalars in the
   * DuckDB grammar; anything else stays readable raw text in the label.
   */
  private captureRawParenGroup(): string {
    this.expectPunct('(')
    let out = '('
    let depth = 1
    let previousWordlike = false
    for (;;) {
      const token = this.next()
      const wordlike =
        token.kind === 'ident' ||
        token.kind === 'number' ||
        token.kind === 'quoted' ||
        token.kind === 'string'
      if (wordlike && previousWordlike) out += ' '
      out += token.text
      if (token.kind === 'punct') {
        if (token.text === '(') depth++
        else if (token.text === ')') {
          depth--
          if (depth === 0) return out
        }
      }
      previousWordlike = wordlike
    }
  }

  /** STRUCT/UNION field list — caller has peeked the `(`. */
  private parseFields(kind: 'struct' | 'union'): DuckDbType {
    this.expectPunct('(')
    if (this.peekPunct(')')) {
      this.next()
      return kind === 'struct' ? { kind: 'struct', fields: [] } : { kind: 'union', fields: [] }
    }
    const fields: DuckDbField[] = []
    for (;;) {
      const nameToken = this.next()
      if (
        nameToken.kind !== 'ident' &&
        nameToken.kind !== 'quoted' &&
        nameToken.kind !== 'string'
      ) {
        throw new TypeParseError(`expected a field name, got ${JSON.stringify(nameToken.text)}`)
      }
      fields.push({ name: nameToken.text, type: this.parseType() })
      const separator = this.next()
      if (separator.kind === 'punct' && separator.text === ')') break
      if (separator.kind === 'punct' && separator.text === ',') continue
      throw new TypeParseError(`expected ',' or ')' in field list`)
    }
    return kind === 'struct' ? { kind: 'struct', fields } : { kind: 'union', fields }
  }
}

/**
 * Parse a DuckDB DESCRIBE type string into a tree. Total: unknown or
 * malformed input degrades to `{ kind: 'unknown', raw }` — never throws.
 *
 * q-1: results are memoized by the raw type string. DuckDB type strings come
 * from the schema (a bounded per-column vocabulary), but the parser is called
 * on the hot render path — per cell per render via editor-kind, decimal, and
 * nested-preview paths. The cache turns that O(cells × renders) work into
 * O(distinct type strings). The bounded cache deliberately evicts FIFO, not
 * LRU: type strings are schema metadata, so a simple value-independent policy
 * keeps the hot path predictable without recency bookkeeping. Returned trees
 * are readonly and must never be mutated by callers; sharing one reference is
 * therefore safe.
 */
const PARSE_CACHE_LIMIT = 1024
const parseCache = new Map<string, DuckDbType>()

export function parseDuckDbType(raw: string): DuckDbType {
  const cached = parseCache.get(raw)
  if (cached !== undefined) return cached
  const parsed = parseDuckDbTypeUncached(raw)
  if (parseCache.size >= PARSE_CACHE_LIMIT) {
    const oldest = parseCache.keys().next().value
    if (oldest !== undefined) parseCache.delete(oldest)
  }
  parseCache.set(raw, parsed)
  return parsed
}

function parseDuckDbTypeUncached(raw: string): DuckDbType {
  try {
    const trimmed = raw.trim()
    if (trimmed === '') return { kind: 'unknown', raw }
    return TypeParser.parse(trimmed)
  } catch {
    return { kind: 'unknown', raw }
  }
}

/** Quote a STRUCT/UNION field name iff it is not a plain identifier. */
function quoteFieldName(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `"${name.replaceAll('"', '""')}"`
}

/**
 * Canonical one-line rendering of a parsed type (used for badges, titles and
 * accessible names of non-expandable composite types). Whitespace inside raw
 * parameter groups is normalized; field names are quoted only when they are
 * not plain identifiers, so this may differ from DuckDB's exact quoting.
 */
export function formatDuckDbType(type: DuckDbType): string {
  switch (type.kind) {
    case 'primitive':
    case 'unknown':
      return type.kind === 'primitive' ? type.label : type.raw
    case 'list': {
      const dims = type.dimensions === '' ? '[]' : type.dimensions
      return `${formatDuckDbType(type.element)}${dims}`
    }
    case 'map':
      return `MAP(${formatDuckDbType(type.key)}, ${formatDuckDbType(type.value)})`
    case 'struct':
    case 'union': {
      const keyword = type.kind === 'struct' ? 'STRUCT' : 'UNION'
      const fields = type.fields
        .map((field) => `${quoteFieldName(field.name)} ${formatDuckDbType(field.type)}`)
        .join(', ')
      return `${keyword}(${fields})`
    }
  }
}
