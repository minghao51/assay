import { tableFromArrays } from 'apache-arrow'
import type { Table } from 'apache-arrow'
import { describe, expect, it } from 'vitest'
import { foldOverlay, initialState } from '@assay/domain'
import type { RowId } from '@assay/domain'
import {
  composeValidationCountSql,
  composeValidationRowKeySql,
  composeValidationViewDropSql,
  composeValidationViewSql,
  failPercentFromCounts,
  normalizeSampleValue,
  readValidationRowCount,
  readValidationRuleRows,
  readValidationRowKeys,
  readValidationSummaryRows,
  VALIDATION_SAMPLE_HARD_MAX,
} from './validate-query'
import type { OverlayComposition } from './overlay-query'

const EMPTY_STATE_COMPOSITION_BASE = {
  viewName: 'assay_t1',
  base: {
    baseAnchor: 'b',
    overlayAnchor: 'o',
    columns: [
      { name: 'id', type: 'BIGINT' },
      { name: 'region', type: 'VARCHAR' },
    ],
    baseRowCount: 3,
  },
} as const

const EMPTY_STATE_COMPOSITION: OverlayComposition = {
  ...EMPTY_STATE_COMPOSITION_BASE,
  state: initialState(EMPTY_STATE_COMPOSITION_BASE.base),
}

describe('composeValidationViewSql', () => {
  it('creates the binding view with row ids and the baked effective ordinal', () => {
    const sql = composeValidationViewSql(EMPTY_STATE_COMPOSITION, 'assay_conf_validate_src')
    expect(sql).toBe(
      'CREATE VIEW "assay_conf_validate_src" AS SELECT *, ' +
        '(row_number() OVER () - 1) AS "assay_overlay_ord" ' +
        'FROM (SELECT "id" AS "id", "region" AS "region", \'base:b#\' || ' +
        'CAST(assay_overlay_ord AS VARCHAR) AS "assay_row_id" ' +
        'FROM (SELECT "id", "region", (row_number() OVER () - 1) AS assay_overlay_ord FROM "assay_t1"))',
    )
  })

  it('orders by the sort key when live inserts exist (effective order)', () => {
    const withInsert = foldOverlay(EMPTY_STATE_COMPOSITION.base, [
      {
        kind: 'row-insert',
        rowId: 'ins:o#0' as RowId,
        position: { kind: 'end' },
        values: new Map(),
      },
    ])
    const composition: OverlayComposition = {
      viewName: EMPTY_STATE_COMPOSITION.viewName,
      base: EMPTY_STATE_COMPOSITION.base,
      state: withInsert.state,
    }
    const sql = composeValidationViewSql(composition, 'v')
    expect(sql).toContain('ORDER BY "assay_key"')
    expect(sql).toContain('UNION ALL')
    // The baked ordinal is computed over the ordered output (one wrap later).
    expect(sql).toContain('FROM (SELECT * FROM (')
  })

  it('quotes a hostile binding name (contained as one identifier)', () => {
    const sql = composeValidationViewSql(EMPTY_STATE_COMPOSITION, 'x"; CREATE TABLE evil; --')
    expect(sql).toContain('"x""; CREATE TABLE evil; --"')
  })
})

describe('validate view helper SQL', () => {
  it('counts, resolves row keys, and drops with quoting', () => {
    expect(composeValidationCountSql('v')).toBe('SELECT count(*)::BIGINT AS "row_count" FROM "v"')
    expect(composeValidationRowKeySql('v', [2, 0])).toBe(
      'SELECT "assay_overlay_ord", "assay_row_id" FROM "v" WHERE "assay_overlay_ord" IN (2, 0)',
    )
    expect(composeValidationViewDropSql('v')).toBe('DROP VIEW IF EXISTS "v"')
  })
})

describe('failPercentFromCounts (the written m5-2 definition)', () => {
  it('rounds half-up via exact integer arithmetic', () => {
    expect(failPercentFromCounts(0, 120)).toBe(0)
    expect(failPercentFromCounts(120, 120)).toBe(100)
    expect(failPercentFromCounts(1, 3)).toBe(33)
    expect(failPercentFromCounts(2, 3)).toBe(67)
    expect(failPercentFromCounts(1, 6)).toBe(17) // 16.67 → 17
    expect(failPercentFromCounts(1, 8)).toBe(13) // exactly 12.5 → 13 (half-up)
    expect(failPercentFromCounts(5, 8)).toBe(63) // exactly 62.5 → 63
    expect(failPercentFromCounts(2, 120)).toBe(2)
    expect(failPercentFromCounts(24, 120)).toBe(20)
    expect(failPercentFromCounts(110, 120)).toBe(92)
    expect(failPercentFromCounts(1, 126)).toBe(1)
  })

  it('is exact where the float intermediates overflow (the reviewer pair)', () => {
    // Both inputs are safe integers, but failCount*200 + rowCount is not:
    // the float sum rounds across the floor boundary (11) where the exact
    // BigInt value is 10 — the m5-2 fix-round regression pin.
    expect(failPercentFromCounts(945755921747804, 9007199254740991)).toBe(10)
  })

  it('pins the half-up direction at a large exact-half boundary', () => {
    // failCount/rowCount = 199/200 → exactly 99.5% → half-up 100, with
    // failCount*200 + rowCount far beyond 2^53 (BigInt intermediates keep
    // the boundary exact; neighboring inputs stay strictly below/above).
    const t = 2 ** 45
    const rowCount = 200 * t
    const failCount = 199 * t
    expect(failPercentFromCounts(failCount, rowCount)).toBe(100) // 99.5 → 100 (half-up)
    expect(failPercentFromCounts(failCount - 1, rowCount)).toBe(99)
    expect(failPercentFromCounts(105553116266496, 7036874417766400)).toBe(2) // exact 1.5
    expect(failPercentFromCounts(105553116266495, 7036874417766400)).toBe(1)
    expect(failPercentFromCounts(105553116266497, 7036874417766400)).toBe(2)
  })

  it('defines 0 for an empty dataset and rejects non-counts', () => {
    expect(failPercentFromCounts(1, 0)).toBe(0)
    expect(failPercentFromCounts(0, 0)).toBe(0)
    expect(() => failPercentFromCounts(-1, 10)).toThrow()
    expect(() => failPercentFromCounts(1.5, 10)).toThrow()
    expect(() => failPercentFromCounts(1, -3)).toThrow()
  })
})

describe('normalizeSampleValue (wire-safe values)', () => {
  it('passes nulls, strings, booleans, and finite numbers through', () => {
    expect(normalizeSampleValue(null)).toBeNull()
    expect(normalizeSampleValue(undefined)).toBeNull()
    expect(normalizeSampleValue('x')).toBe('x')
    expect(normalizeSampleValue(true)).toBe(true)
    expect(normalizeSampleValue(42.5)).toBe(42.5)
  })

  it('renders bigints exactly (safe range as number, beyond as decimal text)', () => {
    expect(normalizeSampleValue(BigInt('42'))).toBe(42)
    expect(normalizeSampleValue(BigInt('9007199254740993'))).toBe('9007199254740993')
  })

  it('renders binary values as lowercase hex text', () => {
    expect(normalizeSampleValue(new Uint8Array([0xde, 0xad]))).toBe('dead')
    expect(normalizeSampleValue(new Uint8Array(0))).toBe('')
  })

  it('renders toString-capable engine objects (exact decimal text for DECIMAL)', () => {
    const decimalLike = {
      toString(): string {
        return '123.45'
      },
    }
    expect(normalizeSampleValue(decimalLike)).toBe('123.45')
  })

  it('renders safe-integer decimal payloads (HUGEINT) as numbers, deterministically', () => {
    // The Arrow decimal128 cell: valueOf first (exact integer ⇒ number),
    // toString as the text fallback — both paths pinned so a plan-dependent
    // engine rendering can never flip a sample's wire type.
    const decimalInteger = {
      valueOf(): number {
        return -10
      },
      toString(): string {
        return '-10'
      },
    }
    expect(normalizeSampleValue(decimalInteger)).toBe(-10)
    const hugeDecimal = {
      valueOf(): number {
        return 1e21
      },
      toString(): string {
        return '1000000000000000000000'
      },
    }
    expect(normalizeSampleValue(hugeDecimal)).toBe('1000000000000000000000')
    // A default-object valueOf (returns the object) never masquerades as a
    // number — it falls through to the loud nested-shape failure.
    expect(() => normalizeSampleValue({ nested: true })).toThrow(/unexpected shape/)
  })

  it('fails loudly on nested/non-renderable cells (engine deviation)', () => {
    expect(() => normalizeSampleValue({ nested: true })).toThrow(/unexpected shape/)
    expect(() => normalizeSampleValue(Number.NaN)).toThrow()
    expect(() => normalizeSampleValue([1, 2])).toThrow()
  })
})

// ---- Result readers ------------------------------------------------------------

function ruleTable(rows: Record<string, unknown[]>): Table {
  // The empty case arrives as a schema-only table (DuckDB always emits a
  // batch); tableFromArrays({}) produces exactly that shape.
  return tableFromArrays(rows as never) as unknown as Table
}

describe('readValidationRuleRows', () => {
  it('reads the empty result as clean (the plan convention)', () => {
    const table = ruleTable({})
    expect(readValidationRuleRows(table, 'row-samples')).toEqual({
      totalRows: null,
      failCount: 0,
      samples: [],
    })
  })

  it('reads a row-samples result with typed cells', () => {
    const table = ruleTable({
      total_rows: [BigInt(120), BigInt(120)],
      fail_count: [BigInt(2), BigInt(2)],
      sample_index: [BigInt(0), BigInt(1)],
      assay_row_ordinal: [BigInt(0), BigInt(119)],
      assay_value: [BigInt(1), BigInt(1)],
    })
    const rows = readValidationRuleRows(table, 'row-samples')
    expect(rows.totalRows).toBe(120)
    expect(rows.failCount).toBe(2)
    expect(rows.samples).toEqual([
      { sampleIndex: 0, ordinal: 0, value: 1 },
      { sampleIndex: 1, ordinal: 119, value: 1 },
    ])
    const textTable = ruleTable({
      total_rows: [BigInt(1)],
      fail_count: [BigInt(1)],
      sample_index: [BigInt(0)],
      assay_row_ordinal: [BigInt(4)],
      assay_value: ['XX'],
    })
    expect(readValidationRuleRows(textTable, 'row-samples').samples).toEqual([
      { sampleIndex: 0, ordinal: 4, value: 'XX' },
    ])
  })

  it('reads a dataset-fact result (exactly one row when violated)', () => {
    const table = ruleTable({ total_rows: [BigInt(6)], fail_count: [BigInt(1)] })
    expect(readValidationRuleRows(table, 'dataset-fact')).toEqual({
      totalRows: 6,
      failCount: 1,
      samples: [],
    })
    const wide = ruleTable({
      total_rows: [BigInt(6), BigInt(6)],
      fail_count: [BigInt(1), BigInt(1)],
    })
    expect(() => readValidationRuleRows(wide, 'dataset-fact')).toThrow(/more than one row/)
  })

  it('fails loudly on missing columns or bad cell shapes', () => {
    const missing = ruleTable({ total_rows: [BigInt(1)] })
    expect(() => readValidationRuleRows(missing, 'row-samples')).toThrow(/fail_count/)
    const badCount = ruleTable({ total_rows: [-1], fail_count: [BigInt(1)] })
    expect(() => readValidationRuleRows(badCount, 'dataset-fact')).toThrow(/unexpected shape/)
  })
})

describe('readValidationSummaryRows / readValidationRowCount / readValidationRowKeys', () => {
  it('maps rule ids to fail counts and rejects duplicates', () => {
    const table = ruleTable({
      rule_id: ['a', 'b'],
      total_rows: [BigInt(6), BigInt(6)],
      fail_count: [BigInt(0), BigInt(2)],
    })
    expect(readValidationSummaryRows(table).get('b')).toBe(2)
    const dup = ruleTable({
      rule_id: ['a', 'a'],
      total_rows: [BigInt(1), BigInt(1)],
      fail_count: [BigInt(0), BigInt(0)],
    })
    expect(() => readValidationSummaryRows(dup)).toThrow(/more than once/)
  })

  it('reads the row count and row-key map, failing on unresolvable keys', () => {
    expect(readValidationRowCount(ruleTable({ row_count: [BigInt(120)] }))).toBe(120)
    expect(() => readValidationRowCount(ruleTable({ row_count: [] }))).toThrow(/unexpected shape/)
    const keys = readValidationRowKeys(
      ruleTable({
        assay_overlay_ord: [BigInt(0), BigInt(9)],
        assay_row_id: ['base:b#0', 'base:b#9'],
      }),
    )
    expect(keys.get(9)).toBe('base:b#9')
    const missingKey = ruleTable({ assay_overlay_ord: [BigInt(0)], assay_row_id: [null] })
    expect(() => readValidationRowKeys(missingKey)).toThrow(/not resolvable text/)
  })
})

describe('VALIDATION_SAMPLE_HARD_MAX', () => {
  it('is the documented clamp (100)', () => {
    expect(VALIDATION_SAMPLE_HARD_MAX).toBe(100)
  })
})
