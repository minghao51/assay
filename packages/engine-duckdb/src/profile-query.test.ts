// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Unit tests for the m2-5 profile SQL composer: the byte-exact aggregate SQL
 * (single-scan base query + per-column top-k), the quoted-identifier and
 * slot-layout invariants from `window-query.ts`'s composer precedent, and
 * the scan-budget contract the executor documents (1 + #categorical scans).
 */
import { describe, expect, it } from 'vitest'
import { classifyProfileColumnType } from './profile-classify'
import {
  composeProfileBaseSql,
  composeProfileTopKSql,
  PROFILE_BASE_SLOT,
  PROFILE_TOP_K,
} from './profile-query'

describe('composeProfileBaseSql (m2-5)', () => {
  it('composes the single-scan aggregate with positional slots and quoted identifiers', () => {
    const plan = composeProfileBaseSql({
      viewName: 'assay_t1',
      columns: [
        { name: 'income', kind: 'numeric' },
        { name: 'country', kind: 'categorical' },
      ],
    })
    // Slot 0 is the row count; then one block per column (numeric width 7,
    // plain width 2); offsets come from the composer (single source of truth).
    expect(plan.offsets).toEqual([1, 8])
    expect(plan.sql).toBe(
      'SELECT count(*)::BIGINT AS "c0", ' +
        'count("income")::BIGINT AS "c1", count(DISTINCT "income")::BIGINT AS "c2", ' +
        'min("income")::DOUBLE AS "c3", max("income")::DOUBLE AS "c4", ' +
        'avg("income")::DOUBLE AS "c5", stddev_samp("income")::DOUBLE AS "c6", ' +
        'quantile_cont("income", [0.5,0.9,0.95,0.99])::DOUBLE[] AS "c7", ' +
        'count("country")::BIGINT AS "c8", count(DISTINCT "country")::BIGINT AS "c9" ' +
        'FROM "assay_t1"',
    )
    // The slot contract the executor reads by.
    expect(PROFILE_BASE_SLOT.nonNull).toBe(0)
    expect(PROFILE_BASE_SLOT.distinct).toBe(1)
    expect(PROFILE_BASE_SLOT.quantiles).toBe(6)
  })

  it('quotes hostile column names so they stay inside identifier context', () => {
    const plan = composeProfileBaseSql({
      viewName: 'assay_t1',
      columns: [{ name: 'in"come" ; DROP VIEW; --', kind: 'categorical' }],
    })
    expect(plan.sql).toBe(
      'SELECT count(*)::BIGINT AS "c0", ' +
        'count("in""come"" ; DROP VIEW; --")::BIGINT AS "c1", ' +
        'count(DISTINCT "in""come"" ; DROP VIEW; --")::BIGINT AS "c2" ' +
        'FROM "assay_t1"',
    )
  })

  it('handles a zero-column spec (count-only profile)', () => {
    const plan = composeProfileBaseSql({ viewName: 'assay_t1', columns: [] })
    expect(plan.offsets).toEqual([])
    expect(plan.sql).toBe('SELECT count(*)::BIGINT AS "c0" FROM "assay_t1"')
  })

  it('classifies-then-composes round-trips the golden-fixture schema', () => {
    // customers.parquet's DESCRIBE output, classified, composed: numeric slots
    // for BIGINT columns, plain blocks for VARCHAR/DATE.
    const schema = [
      { name: 'customer_id', type: 'BIGINT' },
      { name: 'country', type: 'VARCHAR' },
      { name: 'income', type: 'BIGINT' },
      { name: 'signup_date', type: 'DATE' },
    ]
    const plan = composeProfileBaseSql({
      viewName: 'assay_t1',
      columns: schema.map((column) => ({
        name: column.name,
        kind: classifyProfileColumnType(column.type),
      })),
    })
    // customer_id numeric (7 slots), country plain (2), income numeric (7),
    // signup_date plain (2) → offsets 1, 8, 10, 17.
    expect(plan.offsets).toEqual([1, 8, 10, 17])
    expect(plan.sql).toContain('quantile_cont("income", [0.5,0.9,0.95,0.99])')
    expect(plan.sql).toContain('"signup_date"')
    expect(plan.sql).not.toContain('quantile_cont("signup_date"')
  })
})

describe('composeProfileTopKSql (m2-5)', () => {
  it('composes the bounded grouped scan with NULL exclusion and value-ascending ties', () => {
    expect(composeProfileTopKSql({ viewName: 'assay_t1', column: 'country' })).toBe(
      'SELECT CAST("country" AS VARCHAR) AS "v", count(*)::BIGINT AS "n" ' +
        'FROM "assay_t1" WHERE "country" IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1 ASC ' +
        `LIMIT ${String(PROFILE_TOP_K)}`,
    )
  })

  it('quotes hostile column names and honors an explicit k', () => {
    expect(composeProfileTopKSql({ viewName: 'assay_t1', column: 'fl"ag', k: 3 })).toBe(
      'SELECT CAST("fl""ag" AS VARCHAR) AS "v", count(*)::BIGINT AS "n" ' +
        'FROM "assay_t1" WHERE "fl""ag" IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1 ASC LIMIT 3',
    )
  })

  it('rejects a non-positive or non-integer k (composer-owned constant guard)', () => {
    expect(() => composeProfileTopKSql({ viewName: 'v', column: 'c', k: 0 })).toThrow(
      'profile top-k must be a positive integer',
    )
    expect(() => composeProfileTopKSql({ viewName: 'v', column: 'c', k: 1.5 })).toThrow(
      'profile top-k must be a positive integer',
    )
  })
})
