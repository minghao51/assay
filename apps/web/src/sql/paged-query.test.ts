// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from 'vitest'
import { viewNameForTableId } from '@assay/engine-duckdb'
import {
  SQL_PAGE_SIZE,
  composePageQuery,
  resultColumnNames,
  stripTrailingStatementTerminator,
  summarizePage,
} from './paged-query'
import type { QueryBatchLike } from './paged-query'

describe('stripTrailingStatementTerminator', () => {
  it('leaves statements without a trailing terminator untouched', () => {
    expect(stripTrailingStatementTerminator('SELECT 1')).toBe('SELECT 1')
    expect(stripTrailingStatementTerminator('')).toBe('')
  })

  it('strips one trailing semicolon and any trailing whitespace', () => {
    expect(stripTrailingStatementTerminator('SELECT 1;')).toBe('SELECT 1')
    expect(stripTrailingStatementTerminator('SELECT 1 ;  \n\t')).toBe('SELECT 1')
    expect(stripTrailingStatementTerminator('SELECT 1;\n;\t')).toBe('SELECT 1')
  })

  it('preserves semicolons inside string literals (only trailing ones are terminators)', () => {
    expect(stripTrailingStatementTerminator("SELECT ';'")).toBe("SELECT ';'") // ends with the quote
    expect(stripTrailingStatementTerminator("SELECT ';' ;")).toBe("SELECT ';'") // real terminator
  })

  it('reduces whitespace-only input to the empty string', () => {
    expect(stripTrailingStatementTerminator('  \n\t; ')).toBe('')
  })
})

describe('composePageQuery — web-side LIMIT/OFFSET wrap (the engine has no wire-level paging)', () => {
  it('wraps the statement in the composer-owned outer LIMIT/OFFSET', () => {
    expect(composePageQuery('SELECT 1', { limit: 50, offset: 0 })).toEqual({
      ok: true,
      sql: 'SELECT * FROM (SELECT 1) AS _assay_page LIMIT 50 OFFSET 0',
    })
  })

  it('carries the offset math into the wrap', () => {
    const composed = composePageQuery('SELECT * FROM "t1"', { limit: 50, offset: 150 })
    expect(composed.ok).toBe(true)
    if (composed.ok) expect(composed.sql).toContain('LIMIT 50 OFFSET 150')
  })

  it('strips the trailing terminator before wrapping', () => {
    const composed = composePageQuery('SELECT 1;\n', { limit: 50, offset: 0 })
    expect(composed.ok).toBe(true)
    if (composed.ok)
      expect(composed.sql).toBe('SELECT * FROM (SELECT 1) AS _assay_page LIMIT 50 OFFSET 0')
  })

  it('composes multi-statement strings mechanically — the engine rejects them at run time', () => {
    // Documented limitation, not a composer error: DuckDB rejects the wrap
    // readably; the pane surfaces that error like any other engine error.
    const composed = composePageQuery('SELECT 1; SELECT 2', { limit: 50, offset: 0 })
    expect(composed.ok).toBe(true)
    if (composed.ok) expect(composed.sql).toContain('(SELECT 1; SELECT 2)')
  })

  it('rejects empty and whitespace-only input with a reason', () => {
    expect(composePageQuery('', { limit: 50, offset: 0 })).toEqual({
      ok: false,
      reason: 'Enter a SQL query to run.',
    })
    expect(composePageQuery('  ;\n ', { limit: 50, offset: 0 }).ok).toBe(false)
  })

  it('rejects malformed page specs (defensive — specs are composer-owned)', () => {
    expect(composePageQuery('SELECT 1', { limit: 0, offset: 0 }).ok).toBe(false)
    expect(composePageQuery('SELECT 1', { limit: -1, offset: 0 }).ok).toBe(false)
    expect(composePageQuery('SELECT 1', { limit: 1.5, offset: 0 }).ok).toBe(false)
    expect(composePageQuery('SELECT 1', { limit: 50, offset: -1 }).ok).toBe(false)
    expect(composePageQuery('SELECT 1', { limit: 50, offset: Number.NaN }).ok).toBe(false)
  })
})

describe('summarizePage — paging math', () => {
  it('first full page: no previous, not final', () => {
    expect(summarizePage(0, 50, 50)).toEqual({
      hasPrev: false,
      isEmpty: false,
      isFinalPage: false,
      label: 'rows 1–50',
    })
  })

  it('a later full page: has previous', () => {
    expect(summarizePage(50, 50, 50)).toEqual({
      hasPrev: true,
      isEmpty: false,
      isFinalPage: false,
      label: 'rows 51–100',
    })
  })

  it('fewer rows than the page size marks the final page (exhausted result set)', () => {
    expect(summarizePage(50, 50, 10)).toEqual({
      hasPrev: true,
      isEmpty: false,
      isFinalPage: true,
      label: 'rows 51–60',
    })
  })

  it('an empty page (e.g. one step past a page-aligned end) is the final page with no rows', () => {
    expect(summarizePage(1000, 50, 0)).toEqual({
      hasPrev: true,
      isEmpty: true,
      isFinalPage: true,
      label: 'no rows',
    })
  })
})

describe('viewNameForTableId — the engine export the SQL pane addresses views with', () => {
  it('derives the assay_tN view names the pane and the sql-editor e2e pin', () => {
    // Re-pointed pin (m3-0): SqlPanel consumes the engine export directly,
    // and this suite imports the same `viewNameForTableId` symbol from
    // `@assay/engine-duckdb`, so the web-used symbol IS the engine export —
    // there is no local mirror left to drift. What stays pinned is the
    // derivation itself: raw SQL must address the engine's `assay_tN` views
    // (the sql-editor e2e asserts that name verbatim); if the engine ever
    // renames its views, this fails loudly — the app must never silently
    // rewrite user SQL instead.
    expect(viewNameForTableId('t1')).toBe('assay_t1')
    expect(viewNameForTableId('t42')).toBe('assay_t42')
  })
})

describe('resultColumnNames — positional, total header names from the Arrow schema', () => {
  function fakeBatch(numCols: number, fieldNames: readonly string[]): QueryBatchLike {
    return {
      numRows: 0,
      numCols,
      schema: { fields: fieldNames.map((name) => ({ name })) },
      getChildAt: () => null,
    }
  }

  it('uses the schema field names in order', () => {
    expect(resultColumnNames(fakeBatch(2, ['id', 'label']))).toEqual(['id', 'label'])
  })

  it('falls back to positional names for empty/missing fields (never throws)', () => {
    expect(resultColumnNames(fakeBatch(3, ['id', '']))).toEqual(['id', 'column_2', 'column_3'])
    expect(resultColumnNames(fakeBatch(1, []))).toEqual(['column_1'])
  })
})

describe('SQL_PAGE_SIZE', () => {
  it('fits inside one transported Arrow record batch (DuckDB streams ~2048-row batches)', () => {
    expect(SQL_PAGE_SIZE).toBeLessThanOrEqual(2048)
    expect(SQL_PAGE_SIZE).toBeGreaterThan(0)
  })
})
