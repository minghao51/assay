/**
 * Pure paging logic for the SQL editor + result pane (m2-4) — extracted from
 * the component so it is unit-testable in Node (the repo's testing
 * convention: thin components over tested pure modules, like m2-3's
 * `query-state.ts`).
 *
 * Why web-side SQL composition: the engine's `query()` op sends SQL verbatim
 * and has no wire-level limit/offset, and this task must not change the
 * engine (`packages/**` is out of scope). Paging is therefore a *wrap*: the
 * user's statement becomes a subquery of a composer-owned outer
 * `LIMIT/OFFSET`:
 *
 *   SELECT * FROM (<user sql>) AS _assay_page LIMIT <limit> OFFSET <offset>
 *
 * `limit`/`offset` and the alias are composer-owned integers/identifiers —
 * never user content — so the wrap itself adds no injection surface. The
 * user's SQL is engine-SQL *text*: running it is the feature. Trailing
 * semicolons/whitespace are stripped first (a trailing `;` inside the wrap
 * is a syntax error). A multi-statement string cannot be detected here —
 * the wrap composes mechanically and DuckDB rejects it at run time; that
 * error surfaces readably in the pane like any other engine error.
 *
 * Security posture (ADR 0007 spirit): user SQL and result cells are
 * untrusted *content* — they are executed only as SQL by the engine (which
 * is the point) and rendered only as text. Nothing here is ever
 * interpreted as HTML/script, and no result cell is ever re-executed.
 */

import type { ArrowTableLike } from '../grid/provider'

/**
 * Rows per result page — sized so one page always fits inside the engine's
 * single transported Arrow record batch (DuckDB streams ~2048-row batches),
 * keeping `hasMore` false and the pane DOM bounded to one page.
 */
export const SQL_PAGE_SIZE = 50

/** The composer-owned alias of the wrapped subquery (never user content). */
const PAGE_SUBQUERY_ALIAS = '_assay_page'

/** A requested page over the user's statement. */
export interface SqlPageSpec {
  /** Page size — `SQL_PAGE_SIZE` in the UI; parameterized for tests. */
  readonly limit: number
  /** Zero-based first row of the page. */
  readonly offset: number
}

/** Discriminated result of composing a page query. */
export type ComposedPageQuery =
  { readonly ok: true; readonly sql: string } | { readonly ok: false; readonly reason: string }

/**
 * Strip trailing whitespace and semicolons so the statement can be wrapped.
 * Only trailing characters are touched, so a `;` inside a string literal is
 * preserved unless the statement actually ends with it (in which case it is
 * a statement terminator, not content).
 */
export function stripTrailingStatementTerminator(sql: string): string {
  return sql.replace(/[\s;]+$/u, '')
}

/**
 * Wrap the user's statement for one page, or explain why it cannot be run.
 * The composition is mechanical: whatever SQL remains after terminator
 * stripping becomes the subquery (multi-statement strings are rejected by
 * the engine at run time — see the module comment).
 */
export function composePageQuery(userSql: string, page: SqlPageSpec): ComposedPageQuery {
  const inner = stripTrailingStatementTerminator(userSql)
  if (inner === '') return { ok: false, reason: 'Enter a SQL query to run.' }
  if (!Number.isSafeInteger(page.limit) || page.limit <= 0) {
    return {
      ok: false,
      reason: `page size must be a positive integer (got ${String(page.limit)})`,
    }
  }
  if (!Number.isSafeInteger(page.offset) || page.offset < 0) {
    return {
      ok: false,
      reason: `page offset must be a non-negative integer (got ${String(page.offset)})`,
    }
  }
  return {
    ok: true,
    sql: `SELECT * FROM (${inner}) AS ${PAGE_SUBQUERY_ALIAS} LIMIT ${String(page.limit)} OFFSET ${String(page.offset)}`,
  }
}

/** The slice of an Arrow batch schema the pane needs for column headers. */
export interface QueryBatchLike extends ArrowTableLike {
  /** Real Arrow `Table`s satisfy this (`schema.fields[i].name`). */
  readonly schema: { readonly fields: readonly { readonly name: string }[] }
}

/**
 * Column header names from the Arrow schema, positional and total: a missing
 * or empty field name falls back to `column_<n>` so the pane can always
 * render a header row (never throws into the render path).
 */
export function resultColumnNames(batch: QueryBatchLike): string[] {
  const names: string[] = []
  for (let index = 0; index < batch.numCols; index += 1) {
    const name = batch.schema.fields[index]?.name ?? ''
    names.push(name !== '' ? name : `column_${String(index + 1)}`)
  }
  return names
}

/** What the pane shows for one delivered page. */
export interface PageSummary {
  /** A previous page exists (the pane offers "back"). */
  readonly hasPrev: boolean
  /** The page came back empty — the result set has no rows here. */
  readonly isEmpty: boolean
  /**
   * Fewer rows than the page size ⇒ the result set is exhausted; "next" is
   * not offered. (A full page may still be the last one — one extra empty
   * page past the end is the honest cost of not knowing the total without a
   * second count query per page.)
   */
  readonly isFinalPage: boolean
  /** Human-readable range, e.g. `rows 51–100` (or `no rows`). */
  readonly label: string
}

/** Paging math for one delivered page (pure — unit-pinned). */
export function summarizePage(offset: number, pageSize: number, rowsInPage: number): PageSummary {
  const isEmpty = rowsInPage === 0
  return {
    hasPrev: offset > 0,
    isEmpty,
    isFinalPage: rowsInPage < pageSize,
    label: isEmpty ? 'no rows' : `rows ${String(offset + 1)}–${String(offset + rowsInPage)}`,
  }
}
