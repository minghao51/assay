/**
 * Unit tests for the m2-2 SQL composer (`window-query.ts`).
 *
 * The composer is the security-sensitive surface where untrusted filter/sort
 * specs become SQL, so these tests pin the exact bytes:
 *
 * - byte-identity: absent (and empty) filters/sort reproduce the pre-m2-2
 *   window and count SQL exactly (the backward-compatibility contract);
 * - identifier quoting: hostile column names (embedded quotes, `;`, unicode,
 *   spaces, comment markers) stay inside quoted-identifier context;
 * - predicate placement: predicates are WHERE-clause content (never string
 *   literals), parenthesized per predicate and AND-composed;
 * - clause order: WHERE before ORDER BY before LIMIT/OFFSET, and the
 *   pre-validated limit/offset integers are interpolated verbatim (the
 *   clamp interplay: `validateRowWindow` output flows in unchanged).
 */
import { describe, expect, it } from 'vitest'
import {
  composeRowCountSql,
  composeWindowSql,
  orderByClauseSql,
  whereClauseSql,
} from './window-query'

/** Hostile column names an attacker might try (must stay inside quotes). */
const HOSTILE_COLUMNS = [
  'x" ; DROP VIEW assay_t1; --',
  'x" OR "y" = "y',
  '普通列"; SELECT 42; --',
  'col with spaces"',
  "quote'and;semicolons",
] as const

describe('composeWindowSql — backward compatibility (byte-identical legacy SQL)', () => {
  it('composes the exact pre-m2-2 window SQL when filters/sort are absent', () => {
    expect(composeWindowSql({ viewName: 'assay_t1', limit: 5, offset: 0 })).toBe(
      'SELECT * FROM "assay_t1" LIMIT 5 OFFSET 0',
    )
    expect(composeWindowSql({ viewName: 'assay_t7', limit: 1000, offset: 10000 })).toBe(
      'SELECT * FROM "assay_t7" LIMIT 1000 OFFSET 10000',
    )
  })

  it('composes the exact pre-m2-2 projection when only columns are given', () => {
    expect(
      composeWindowSql({
        viewName: 'assay_t1',
        columns: ['income', 'country with "quotes"'],
        limit: 3,
        offset: 2,
      }),
    ).toBe('SELECT "income", "country with ""quotes""" FROM "assay_t1" LIMIT 3 OFFSET 2')
  })

  it('treats empty filters/sort exactly like absent (the grid null-clear protocol)', () => {
    const base = { viewName: 'assay_t1', limit: 5, offset: 0 }
    expect(composeWindowSql({ ...base, filters: [], sort: [] })).toBe(composeWindowSql(base))
    expect(composeRowCountSql({ viewName: 'assay_t1', filters: [] })).toBe(
      composeRowCountSql({ viewName: 'assay_t1' }),
    )
  })
})

describe('whereClauseSql — predicate placement and identifier quoting', () => {
  it('places the quoted column before the verbatim predicate, parenthesized', () => {
    expect(whereClauseSql([{ column: 'income', predicate: '> 50000' }])).toBe('("income" > 50000)')
  })

  it('AND-composes multiple predicates, including duplicate columns', () => {
    expect(
      whereClauseSql([
        { column: 'country', predicate: "= 'SG'" },
        { column: 'income', predicate: 'IS NOT NULL' },
        { column: 'income', predicate: '< 60000' },
      ]),
    ).toBe('("country" = \'SG\') AND ("income" IS NOT NULL) AND ("income" < 60000)')
  })

  it('returns null for absent and empty filter lists', () => {
    expect(whereClauseSql(undefined)).toBeNull()
    expect(whereClauseSql([])).toBeNull()
  })

  it.each(HOSTILE_COLUMNS)('keeps hostile column %j inside identifier quotes', (column) => {
    const quoted = `"${column.replaceAll('"', '""')}"`
    const where = whereClauseSql([{ column, predicate: '> 1' }])
    // Byte-exact: the escaped identifier delimited by two quotes, predicate after.
    expect(where).toBe(`(${quoted} > 1)`)
  })

  it('embeds the predicate verbatim — never inside a string literal', () => {
    // A predicate containing quote characters must reach the SQL as SQL text
    // (user-authored SQL per grid contracts v1), not be re-quoted into a value.
    const where = whereClauseSql([{ column: 'name', predicate: "= 'it''s' OR \"name\" LIKE '_%'" }])
    expect(where).toBe("(\"name\" = 'it''s' OR \"name\" LIKE '_%')")
  })
})

describe('orderByClauseSql — sort keys', () => {
  it('composes explicit directions over quoted columns', () => {
    expect(orderByClauseSql([{ column: 'income', direction: 'desc' }])).toBe('"income" desc')
    expect(
      orderByClauseSql([
        { column: 'country', direction: 'asc' },
        { column: 'income', direction: 'desc' },
      ]),
    ).toBe('"country" asc, "income" desc')
  })

  it('quotes hostile sort columns like filter columns', () => {
    expect(orderByClauseSql([{ column: 'x" ; DROP TABLE t; --', direction: 'asc' }])).toBe(
      '"x"" ; DROP TABLE t; --" asc',
    )
  })

  it('returns null for absent and empty sort lists', () => {
    expect(orderByClauseSql(undefined)).toBeNull()
    expect(orderByClauseSql([])).toBeNull()
  })
})

describe('composeWindowSql — full clause order and clamp interplay', () => {
  it('orders clauses WHERE → ORDER BY → LIMIT → OFFSET', () => {
    expect(
      composeWindowSql({
        viewName: 'assay_t2',
        columns: ['id', 'label'],
        filters: [
          { column: 'bucket', predicate: '>= 3' },
          { column: 'label', predicate: "LIKE 'row%'" },
        ],
        sort: [
          { column: 'bucket', direction: 'desc' },
          { column: 'id', direction: 'asc' },
        ],
        limit: 1000,
        offset: 40,
      }),
    ).toBe(
      'SELECT "id", "label" FROM "assay_t2" ' +
        'WHERE ("bucket" >= 3) AND ("label" LIKE \'row%\') ' +
        'ORDER BY "bucket" desc, "id" asc ' +
        'LIMIT 1000 OFFSET 40',
    )
  })

  it('interpolates the pre-validated (clamped) limit/offset verbatim', () => {
    // `validateRowWindow` output flows in unchanged: the composer never
    // re-derives bounds, so the clamp happens exactly once, before composition.
    expect(composeWindowSql({ viewName: 'assay_t1', limit: 1000, offset: 148_500_000 })).toBe(
      'SELECT * FROM "assay_t1" LIMIT 1000 OFFSET 148500000',
    )
  })
})

describe('composeRowCountSql — filtered counts', () => {
  it('composes the exact pre-m2-2 count SQL without filters', () => {
    expect(composeRowCountSql({ viewName: 'assay_t1' })).toBe(
      'SELECT count(*)::BIGINT AS row_count FROM "assay_t1"',
    )
  })

  it('narrows the count with the AND-composed WHERE clause', () => {
    expect(
      composeRowCountSql({
        viewName: 'assay_t1',
        filters: [{ column: 'income', predicate: '> 50000' }],
      }),
    ).toBe('SELECT count(*)::BIGINT AS row_count FROM "assay_t1" WHERE ("income" > 50000)')
  })
})
