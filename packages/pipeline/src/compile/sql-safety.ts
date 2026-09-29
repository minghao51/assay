// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Conservative single-statement classifier for verbatim `sql` nodes (p-2).
 *
 * ADR 0029 lets a pipeline carry arbitrary SQL, but the P1 runner executes a
 * `sql` node's text as one statement on the user's local engine. This module
 * is the pure, total gate that decides whether a piece of text is *one
 * read-only statement* the P1 vocabulary can accept. It is deliberately
 * conservative: anything ambiguous is refused, and the caller (the compiler)
 * turns a refusal into a typed `invalid-sql` error that points at the
 * documented escape-hatch contract.
 *
 * ## What is checked
 *
 * 1. **Lexical safety** — the scan is string-aware (`'…''…'`), identifier-
 *    quote-aware (`"…""…"`, also backtick identifiers), comment-aware
 *    (`-- line`, nestable block comments), and dollar-quote-aware
 *    (`$$…$$`, `$tag$…$tag$`). A semicolon, keyword, or paren inside any of
 *    those lexemes is content, not structure — so an injection probe such as
 *    `SELECT '; DROP TABLE t' AS "delete"` is classified as exactly the
 *    single read statement it is.
 * 2. **Single statement** — top-level semicolons separate statements; a
 *    trailing/leading empty segment is ignored, but two non-empty statements
 *    are refused. Unbalanced parentheses are refused (trailing garbage such
 *    as `SELECT 1 )` fails closed).
 * 3. **Read allowlist** — the statement must begin with a read-only leading
 *    keyword (`SELECT`, `WITH`, `VALUES`, `FROM`, `TABLE`, `PIVOT`;
 *    punctuation such as an opening paren may precede it). `UNPIVOT` is
 *    deliberately excluded because its syntax requires `INTO`, a
 *    side-effect keyword (fail closed).
 * 4. **No side-effect keywords** — any bare keyword in the statement that
 *    names a data-modifying or utility statement is refused (`INSERT`,
 *    `UPDATE`, `DELETE`, `CREATE`, `DROP`, `ALTER`, `COPY`, `ATTACH`,
 *    `DETACH`, `PRAGMA`, `SET`, `CALL`, `INSTALL`, `LOAD`, `EXPORT`,
 *    `IMPORT`, `BEGIN`, `COMMIT`, `ROLLBACK`, `TRUNCATE`, `MERGE`, `GRANT`,
 *    `REVOKE`, `VACUUM`, `CHECKPOINT`, `INTO`, `UNLOAD`, `USE`, `RESET`).
 *    The check is token-level and case-insensitive; quoted identifiers and
 *    string/comment/dollar-quoted content never match.
 *
 * ## What is deliberately *not* checked
 *
 * This is not a SQL parser. It does not verify alias syntax, column lists,
 * function arity, or dialects; the engine rejects a malformed-but-classified
 * read statement at execution. The classifier's job is the safety property
 * (one read statement, no side effects) and it fails closed on ambiguity
 * where it can.
 *
 * Purity: pure string scanning — no React, no browser APIs, no engine, no
 * `@assay/*` imports (lint-enforced).
 */

/** Why a verbatim SQL body was refused. `ok: true` carries no reason. */
export type VerbatimSqlRefusal =
  | 'empty'
  | 'unterminated-quote'
  | 'unterminated-comment'
  | 'unterminated-dollar-quote'
  | 'unbalanced-parens'
  | 'multi-statement'
  | 'not-a-read-statement'
  | 'forbidden-keyword'

/** The classifier outcome. Total over every string; never throws. */
export type VerbatimSqlClassification =
  { readonly ok: true } | { readonly ok: false; readonly refusal: VerbatimSqlRefusal }

/**
 * Leading keywords that begin a read-only statement. Punctuation may precede
 * the keyword (a parenthesized `(SELECT …)` is still a read statement).
 */
const READ_STATEMENT_KEYWORDS: ReadonlySet<string> = new Set([
  'SELECT',
  'WITH',
  'VALUES',
  'FROM',
  'TABLE',
  'PIVOT',
])

/**
 * Bare keywords that name a data-modifying or engine-utility statement.
 * `REPLACE` is deliberately absent: it is a common scalar function
 * (`replace(x, …)`) and a `REPLACE INTO` statement is already refused by the
 * leading-keyword allowlist.
 */
const FORBIDDEN_KEYWORDS: ReadonlySet<string> = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'CREATE',
  'DROP',
  'ALTER',
  'COPY',
  'ATTACH',
  'DETACH',
  'PRAGMA',
  'SET',
  'CALL',
  'INSTALL',
  'LOAD',
  'EXPORT',
  'IMPORT',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'TRUNCATE',
  'MERGE',
  'GRANT',
  'REVOKE',
  'VACUUM',
  'CHECKPOINT',
  'INTO',
  'UNLOAD',
  'USE',
  'RESET',
])

interface ScanResult {
  /** Non-empty statements, each a list of bare-word tokens (in order). */
  readonly statements: readonly (readonly string[])[]
  /** The first lexical failure, or `null` when the scan completed. */
  readonly failure: VerbatimSqlRefusal | null
}

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v'
}

function isWordStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_'
}

function isWordChar(ch: string): boolean {
  return isWordStart(ch) || (ch >= '0' && ch <= '9') || ch === '$'
}

function isDollarTagChar(ch: string): boolean {
  return isWordStart(ch) || (ch >= '0' && ch <= '9')
}

/** Match a dollar-quote opener at `sql[index]` (`$$` or `$tag$`), or `null`. */
function matchDollarTag(sql: string, index: number): string | null {
  if (sql[index] !== '$') return null
  if (sql[index + 1] === '$') return '$$'
  let i = index + 1
  if (i >= sql.length || !isWordStart(sql[i] as string)) return null
  while (i < sql.length && isDollarTagChar(sql[i] as string)) i++
  return sql[i] === '$' ? sql.slice(index, i + 1) : null
}

/**
 * Scan SQL text into bare-word statements, skipping string/identifier/
 * comment/dollar-quoted content. Total: an unterminated lexeme becomes a
 * `failure` rather than an exception.
 */
function scan(sql: string): ScanResult {
  const statements: string[][] = []
  let current: string[] = []
  let depth = 0
  let failure: VerbatimSqlRefusal | null = null
  let i = 0
  const n = sql.length

  while (i < n) {
    const ch = sql[i] as string

    if (isWhitespace(ch)) {
      i++
      continue
    }

    // Line comment.
    if (ch === '-' && sql[i + 1] === '-') {
      i += 2
      while (i < n && sql[i] !== '\n' && sql[i] !== '\r') i++
      continue
    }

    // Nestable block comment.
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2
      let level = 1
      while (i < n && level > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          level++
          i += 2
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          level--
          i += 2
        } else {
          i++
        }
      }
      if (level > 0) {
        failure = 'unterminated-comment'
        break
      }
      continue
    }

    // String literal (single quote; `''` escapes).
    if (ch === "'") {
      i++
      let closed = false
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2
            continue
          }
          i++
          closed = true
          break
        }
        i++
      }
      if (!closed) {
        failure = 'unterminated-quote'
        break
      }
      continue
    }

    // Quoted identifier (double quote or backtick; doubled to escape).
    if (ch === '"' || ch === '`') {
      const quote = ch
      i++
      let closed = false
      while (i < n) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2
            continue
          }
          i++
          closed = true
          break
        }
        i++
      }
      if (!closed) {
        failure = 'unterminated-quote'
        break
      }
      continue
    }

    // Dollar-quoted string.
    if (ch === '$') {
      const tag = matchDollarTag(sql, i)
      if (tag !== null) {
        const end = sql.indexOf(tag, i + tag.length)
        if (end === -1) {
          failure = 'unterminated-dollar-quote'
          break
        }
        i = end + tag.length
        continue
      }
      i++
      continue
    }

    // Statement separator.
    if (ch === ';') {
      if (current.length > 0) statements.push(current)
      current = []
      depth = 0
      i++
      continue
    }

    // Parenthesis balance (a conservative trailing-garbage check).
    if (ch === '(') {
      depth++
      i++
      continue
    }
    if (ch === ')') {
      depth--
      if (depth < 0) {
        failure = 'unbalanced-parens'
        break
      }
      i++
      continue
    }

    // Bare word / keyword.
    if (isWordStart(ch)) {
      let j = i + 1
      while (j < n && isWordChar(sql[j] as string)) j++
      current.push(sql.slice(i, j))
      i = j
      continue
    }

    // Any other punctuation is not structurally significant.
    i++
  }

  if (failure === null && depth !== 0) failure = 'unbalanced-parens'
  if (failure === null && current.length > 0) statements.push(current)
  return { statements, failure }
}

/**
 * Classify verbatim SQL as a single read-only statement. Total over every
 * string; a caller bug behind a cast degrades to `empty` rather than a
 * throw. The returned reason is a fixed category (never user text), so the
 * compiler's error message stays value-free.
 */
export function classifyVerbatimSql(sql: unknown): VerbatimSqlClassification {
  if (typeof sql !== 'string') return { ok: false, refusal: 'empty' }
  const { statements, failure } = scan(sql)
  if (failure !== null) return { ok: false, refusal: failure }
  if (statements.length === 0) return { ok: false, refusal: 'empty' }
  if (statements.length > 1) return { ok: false, refusal: 'multi-statement' }

  const words = statements[0] as readonly string[]
  const leading = words[0]
  if (leading === undefined || !READ_STATEMENT_KEYWORDS.has(leading.toUpperCase())) {
    return { ok: false, refusal: 'not-a-read-statement' }
  }
  for (const word of words) {
    if (FORBIDDEN_KEYWORDS.has(word.toUpperCase())) {
      return { ok: false, refusal: 'forbidden-keyword' }
    }
  }
  return { ok: true }
}
