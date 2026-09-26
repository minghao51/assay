// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * SQL literal and identifier helpers (m5-1) — **the composition contract
 * with the engine**.
 *
 * Injection hard requirement (queue + the m4-2 lesson): every value that
 * reaches SQL inside a validation plan goes through one of the helpers in
 * this module. No `compile.ts` code path concatenates a user-derived value
 * into SQL directly — contract values, column names and the relation name
 * may only appear in a plan's SQL as the output of these functions, which
 * hostile-input pins cover (quotes, backslashes, unicode, `$$`, SQL
 * comment/quote syntax, mixed content). This mirrors engine-duckdb's
 * `quotedIdentifier`/`sqlStringLiteral` conventions; the code is deliberately
 * in-package because `@assay/validation` must not depend on an engine
 * implementation (lint-enforced purity, docs/engineering/
 * 03-repository-structure.md §3).
 *
 * ## The contract, for the m5-2 executor
 *
 * - `quoteIdentifier(name)` — SQL identifier (column names, the target
 *   relation name). Double-quote escaping; total over all strings.
 * - `sqlStringLiteral(text)` — SQL string literal (regex patterns,
 *   `allowed-values` strings). Single-quote escaping; total over all
 *   strings. DuckDB does not process backslash escapes inside
 *   single-quoted strings, so `''` escaping is the only transformation —
 *   patterns stay byte-faithful.
 * - `sqlNumberLiteral(value)` / `sqlIntegerLiteral(value)` — numeric
 *   literals rendered from the *exact* values m5-0 guarantees (its
 *   exact-or-rejected policy means the JS number denotes the written
 *   decimal; the shortest round-trip rendering preserves it). Preconditions
 *   are asserted: `compile.ts` validates every value before calling (a
 *   non-finite number can have no honest SQL spelling), so the throws are
 *   unreachable internal invariants, not input handling.
 * - `sqlBooleanLiteral(value)` — `TRUE`/`FALSE` keywords.
 *
 * **NUL characters** cannot be represented in SQL statement text (engines
 * truncate or reject them). The compiler rejects any string carrying one
 * *before* a helper runs (typed binding error), so the string helpers stay
 * total; this is documented on the helpers and pinned by compile-level
 * tests, not silently dropped here.
 *
 * Purity: pure string/number logic — no React, no browser APIs, no engine
 * imports.
 */

/**
 * Quote a SQL identifier (double-quote escaping): the only sanctioned way a
 * column name or the target relation name may enter plan SQL. Total over
 * all strings — quoting itself cannot be injected through.
 */
export function quoteIdentifier(name: string): string {
  return '"' + name.replaceAll('"', '""') + '"'
}

/**
 * Quote a SQL string literal (single-quote escaping): the only sanctioned
 * way contract text (a `regex` pattern, an `allowed-values` string) may
 * enter plan SQL. Total over all strings; callers must pre-reject NUL
 * (see module doc).
 */
export function sqlStringLiteral(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'"
}

/**
 * Render a finite number as a SQL numeric literal: the shortest decimal
 * that round-trips to exactly this double (ECMAScript `Number::toString`),
 * so the engine reads back the value m5-0 verified. Asserts finiteness —
 * there is no honest SQL spelling of NaN/±Infinity, and the compiler
 * rejects those upstream as typed binding errors.
 */
export function sqlNumberLiteral(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error(`sqlNumberLiteral: non-finite value has no SQL literal (${String(value)})`)
  }
  // `-0` renders as `0` — m5-0 canonicalizes ±0 to one value, so this is
  // the same contract number.
  return String(value)
}

/**
 * Render a safe integer as a SQL integer literal (row-count bounds, the
 * sample LIMIT). Asserts the safe-integer precondition the compiler
 * validates upstream.
 */
export function sqlIntegerLiteral(value: number): string {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`sqlIntegerLiteral: not a safe integer (${String(value)})`)
  }
  return String(value)
}

/** Render a boolean as the SQL keyword `TRUE`/`FALSE`. */
export function sqlBooleanLiteral(value: boolean): string {
  return value ? 'TRUE' : 'FALSE'
}
