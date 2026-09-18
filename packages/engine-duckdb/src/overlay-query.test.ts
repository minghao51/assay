/**
 * Unit tests for the overlay SQL composer (`overlay-query.ts`, m4-2).
 *
 * The composer is the security-sensitive surface where host overlay payloads
 * become SQL, so these tests pin the exact composed bytes:
 *
 * - quoting: hostile anchors, columns, and cell strings stay inside their
 *   lexical contexts (identifiers quoted, values string-literal-escaped);
 * - ordering: the `assay_key` list grammar reproduces the sort-key scheme
 *   (start < base < end < leftovers, before-children inside, after-children
 *   outside) — the effectiveRowIds equivalence itself is pinned against the
 *   real engine by the conformance suite;
 * - tombstones: deleted base ordinals are excluded via `NOT IN`, and
 *   tombstoned inserts contribute no branch;
 * - edits/casts/renames: bounded CASE arms, CAST-wrapped literals (the
 *   union branch keeps the column type), renamed aliases;
 * - the CSV formula-injection guard: applied to VARCHAR columns only, on
 *   both the base branch AND the insert branches (a bait value inserted into
 *   a row must be sanitized exactly like an edited base cell);
 * - exports: deterministic per-format COPY options; `arrow` returns null
 *   (streamed path) with the identical SELECT available separately.
 */
import { foldOverlay } from '@assay/domain'
import type { EditOp, OverlayBase, RowId } from '@assay/domain'

/** Test-side branded-id constructor for canonical literal ids. */
const rid = (text: string): RowId => text as RowId
import { describe, expect, it } from 'vitest'
import {
  cellLiteralSql,
  composeOverlayCountSql,
  composeOverlayExportSql,
  composeOverlaySchemaSql,
  composeOverlayWindowSql,
  composeSourceSql,
  exportFileExtension,
  formulaInjectionGuardSql,
  insertSortKeys,
  OVERLAY_ROW_ID_COLUMN,
  RESERVED_OVERLAY_COLUMN_NAMES,
} from './overlay-query'

const BASE: OverlayBase = {
  baseAnchor: 'b1',
  overlayAnchor: 'o1',
  columns: [
    { name: 'id', type: 'BIGINT' },
    { name: 'label', type: 'VARCHAR' },
  ],
  baseRowCount: 3,
}

function stateFor(ops: EditOp[]): ReturnType<typeof foldOverlay>['state'] {
  return foldOverlay(BASE, ops).state
}

function compositionFor(ops: EditOp[]): {
  viewName: string
  base: OverlayBase
  state: ReturnType<typeof stateFor>
} {
  return { viewName: 'assay_t1', base: BASE, state: stateFor(ops) }
}

describe('overlay composition — empty overlay', () => {
  it('composes the plain base view when there are no ops', () => {
    const windowSql = composeOverlayWindowSql({ ...compositionFor([]), limit: 5, offset: 0 })
    expect(windowSql).toBe(
      'SELECT "id", "label" FROM (SELECT "id" AS "id", "label" AS "label" FROM ' +
        '(SELECT "id", "label", (row_number() OVER () - 1) AS assay_overlay_ord FROM "assay_t1")) ' +
        'LIMIT 5 OFFSET 0',
    )
  })

  it('composes the count over the plain base view', () => {
    expect(composeOverlayCountSql(compositionFor([]))).toBe(
      'SELECT count(*)::BIGINT AS row_count FROM (SELECT "id" AS "id", "label" AS "label" FROM ' +
        '(SELECT "id", "label", (row_number() OVER () - 1) AS assay_overlay_ord FROM "assay_t1"))',
    )
  })

  it('composes the DESCRIBE over the base projection', () => {
    expect(composeOverlaySchemaSql(compositionFor([]))).toBe(
      'DESCRIBE SELECT "id" AS "id", "label" AS "label" FROM ' +
        '(SELECT "id", "label", (row_number() OVER () - 1) AS assay_overlay_ord FROM "assay_t1")',
    )
  })
})

describe('overlay composition — tombstones, edits, renames, casts', () => {
  const OPS: EditOp[] = [
    { kind: 'row-delete', rowId: rid('base:b1#1') },
    {
      kind: 'cell-set',
      rowId: rid('base:b1#0'),
      column: 'label',
      value: { kind: 'string', value: 'edited' },
    },
    {
      kind: 'cell-set',
      rowId: rid('base:b1#2'),
      column: 'id',
      value: { kind: 'text', text: '007' },
    },
    { kind: 'column-rename', from: 'label', to: 'label_v2' },
    { kind: 'column-cast', column: 'id', targetType: 'VARCHAR' },
  ]

  it('excludes tombstoned ordinals and overlays edits per column', () => {
    const windowSql = composeOverlayWindowSql({ ...compositionFor(OPS), limit: 5, offset: 0 })
    expect(windowSql).toBe(
      'SELECT "id", "label_v2" FROM (' +
        'SELECT ' +
        'CASE WHEN assay_overlay_ord = 2 THEN CAST(\'007\' AS VARCHAR) ELSE CAST("id" AS VARCHAR) END AS "id", ' +
        'CASE WHEN assay_overlay_ord = 0 THEN CAST(\'edited\' AS VARCHAR) ELSE "label" END AS "label_v2" ' +
        'FROM (SELECT "id", "label", (row_number() OVER () - 1) AS assay_overlay_ord FROM "assay_t1") ' +
        'WHERE assay_overlay_ord NOT IN (1)) LIMIT 5 OFFSET 0',
    )
  })

  it('keeps NULL as a typed NULL, not absence', () => {
    const ops: EditOp[] = [
      { kind: 'cell-set', rowId: rid('base:b1#0'), column: 'label', value: { kind: 'null' } },
    ]
    const sql = composeOverlayWindowSql({ ...compositionFor(ops), limit: 1, offset: 0 })
    expect(sql).toContain('CASE WHEN assay_overlay_ord = 0 THEN CAST(NULL AS VARCHAR) ELSE')
  })

  it('tombstoned inserts contribute no branch; restored ones do', () => {
    const deleted: EditOp[] = [
      {
        kind: 'row-insert',
        rowId: rid('ins:o1#0'),
        position: { kind: 'start' },
        values: new Map([['id', { kind: 'number', value: 9 }]]),
      },
      { kind: 'row-delete', rowId: rid('ins:o1#0') },
    ]
    expect(
      composeOverlayWindowSql({ ...compositionFor(deleted), limit: 5, offset: 0 }),
    ).not.toContain('UNION ALL')
    const restored: EditOp[] = [...deleted, { kind: 'row-restore', rowId: rid('ins:o1#0') }]
    expect(composeOverlayWindowSql({ ...compositionFor(restored), limit: 5, offset: 0 })).toContain(
      'UNION ALL',
    )
  })

  it('rejects reserved column names with a clear error', () => {
    for (const reserved of RESERVED_OVERLAY_COLUMN_NAMES) {
      const hostile: OverlayBase = { ...BASE, columns: [{ name: reserved, type: 'BIGINT' }] }
      expect(() =>
        composeOverlayWindowSql({
          viewName: 'assay_t1',
          base: hostile,
          state: foldOverlay(hostile, []).state,
          limit: 1,
          offset: 0,
        }),
      ).toThrow(/reserved/)
    }
  })
})

describe('overlay composition — insert branches and the sort-key grammar', () => {
  const OPS: EditOp[] = [
    {
      kind: 'row-insert',
      rowId: rid('ins:o1#5'),
      position: { kind: 'start' },
      values: new Map([['id', { kind: 'number', value: 100 }]]),
    },
    {
      kind: 'row-insert',
      rowId: rid('ins:o1#7'),
      position: { kind: 'after', rowId: rid('base:b1#0') },
      values: new Map([['label', { kind: 'string', value: 'after' }]]),
    },
  ]

  it('unions typed insert branches carrying the sort keys and row ids', () => {
    const sql = composeOverlayWindowSql({
      ...compositionFor(OPS),
      limit: 10,
      offset: 0,
      includeRowIds: true,
    })
    expect(sql).toBe(
      'SELECT ' +
        `"${OVERLAY_ROW_ID_COLUMN}", "id", "label" FROM (` +
        'SELECT "id" AS "id", "label" AS "label", ' +
        '\'base:b1#\' || CAST(assay_overlay_ord AS VARCHAR) AS "assay_row_id", ' +
        '[0, assay_overlay_ord, 1] AS "assay_key" ' +
        'FROM (SELECT "id", "label", (row_number() OVER () - 1) AS assay_overlay_ord FROM "assay_t1") ' +
        'UNION ALL ' +
        'SELECT CAST(100 AS BIGINT) AS "id", CAST(NULL AS VARCHAR) AS "label", \'ins:o1#5\' AS "assay_row_id", [-1, 5, 1] AS "assay_key" ' +
        'UNION ALL ' +
        'SELECT CAST(NULL AS BIGINT) AS "id", CAST(\'after\' AS VARCHAR) AS "label", \'ins:o1#7\' AS "assay_row_id", [0, 0, 1, 7, 1] AS "assay_key"' +
        ') ORDER BY "assay_key" LIMIT 10 OFFSET 0',
    )
  })

  it('tiebreaks explicit sorts by assay_key', () => {
    const sql = composeOverlayWindowSql({
      ...compositionFor(OPS),
      sort: [{ column: 'label', direction: 'desc' }],
      limit: 10,
      offset: 0,
    })
    expect(sql).toContain('ORDER BY "label" desc, "assay_key"')
  })

  it('orders by assay_key alone without explicit sort, and skips it without inserts', () => {
    const withInserts = composeOverlayWindowSql({ ...compositionFor(OPS), limit: 1, offset: 0 })
    expect(withInserts).toContain('ORDER BY "assay_key" LIMIT 1 OFFSET 0')
    const without = composeOverlayWindowSql({ ...compositionFor([]), limit: 1, offset: 0 })
    expect(without).not.toContain('ORDER BY')
  })
})

describe('insertSortKeys — the effectiveRowIds key grammar', () => {
  it('assigns start/end/before/after/leftover keys per the documented scheme', () => {
    const ops: EditOp[] = [
      {
        kind: 'row-insert',
        rowId: rid('ins:o1#1'),
        position: { kind: 'start' },
        values: new Map(),
      },
      { kind: 'row-insert', rowId: rid('ins:o1#2'), position: { kind: 'end' }, values: new Map() },
      {
        kind: 'row-insert',
        rowId: rid('ins:o1#3'),
        position: { kind: 'before', rowId: rid('base:b1#0') },
        values: new Map(),
      },
      {
        kind: 'row-insert',
        rowId: rid('ins:o1#4'),
        position: { kind: 'after', rowId: rid('base:b1#0') },
        values: new Map(),
      },
      // Dead anchor (tombstoned base row) → leftover (degrades to the end).
      { kind: 'row-delete', rowId: rid('base:b1#2') },
      {
        kind: 'row-insert',
        rowId: rid('ins:o1#5'),
        position: { kind: 'after', rowId: rid('base:b1#2') },
        values: new Map(),
      },
    ]
    const keys = insertSortKeys(BASE, stateFor(ops))
    expect(keys.get('ins:o1#1')).toEqual([-1, 1, 1]) // start
    expect(keys.get('ins:o1#3')).toEqual([0, 0, 0, 3, 1]) // before base 0
    expect(keys.get('ins:o1#4')).toEqual([0, 0, 1, 4, 1]) // after base 0
    expect(keys.get('ins:o1#2')).toEqual([1, 2, 1]) // end
    expect(keys.get('ins:o1#5')).toEqual([2, 0, 1]) // leftover: dead anchor
  })

  it('nests chains depth-first and linearizes cycles in visit order', () => {
    const chain: EditOp[] = [
      {
        kind: 'row-insert',
        rowId: rid('ins:o1#1'),
        position: { kind: 'after', rowId: rid('base:b1#0') },
        values: new Map(),
      },
      {
        kind: 'row-insert',
        rowId: rid('ins:o1#2'),
        position: { kind: 'after', rowId: rid('ins:o1#1') },
        values: new Map(),
      },
      {
        kind: 'row-insert',
        rowId: rid('ins:o1#3'),
        position: { kind: 'before', rowId: rid('ins:o1#2') },
        values: new Map(),
      },
    ]
    const keys = insertSortKeys(BASE, stateFor(chain))
    expect(keys.get('ins:o1#1')).toEqual([0, 0, 1, 1, 1])
    expect(keys.get('ins:o1#2')).toEqual([0, 0, 1, 1, 1, 2, 1])
    expect(keys.get('ins:o1#3')).toEqual([0, 0, 1, 1, 1, 2, 0, 3, 1])
    // Cycle: i5 after i6, i6 after i5 → both leftovers, visit order by seq.
    const cycle: EditOp[] = [
      {
        kind: 'row-insert',
        rowId: rid('ins:o1#5'),
        position: { kind: 'after', rowId: rid('ins:o1#6') },
        values: new Map(),
      },
      {
        kind: 'row-insert',
        rowId: rid('ins:o1#6'),
        position: { kind: 'after', rowId: rid('ins:o1#5') },
        values: new Map(),
      },
    ]
    const cycleKeys = insertSortKeys(BASE, stateFor(cycle))
    expect(cycleKeys.get('ins:o1#5')).toEqual([2, 0, 1])
    // i6 is i5's after-child inside the leftover chain: [2, 0, 1, 6, 1].
    expect(cycleKeys.get('ins:o1#6')).toEqual([2, 0, 1, 6, 1])
  })
})

describe('cellLiteralSql and the formula-injection guard', () => {
  it('casts every value under the column type and escapes strings', () => {
    expect(cellLiteralSql({ kind: 'null' }, 'BIGINT')).toBe('CAST(NULL AS BIGINT)')
    expect(cellLiteralSql({ kind: 'boolean', value: true }, 'BOOLEAN')).toBe(
      'CAST(TRUE AS BOOLEAN)',
    )
    expect(cellLiteralSql({ kind: 'number', value: 1.5 }, 'DOUBLE')).toBe('CAST(1.5 AS DOUBLE)')
    expect(cellLiteralSql({ kind: 'string', value: "it's" }, 'VARCHAR')).toBe(
      "CAST('it''s' AS VARCHAR)",
    )
    expect(cellLiteralSql({ kind: 'text', text: '2025-06-30' }, 'DATE')).toBe(
      "CAST('2025-06-30' AS DATE)",
    )
    expect(() => cellLiteralSql({ kind: 'number', value: Number.NaN }, 'DOUBLE')).toThrow(
      /materialized/,
    )
  })

  it('guards leading =, +, -, @ and embedded tab/CR, passing NULL through', () => {
    const guard = formulaInjectionGuardSql('"c"')
    // The exact composed bytes (CLI-verified semantics against DuckDB 1.5.5).
    expect(guard).toBe(
      'CASE WHEN "c" IS NULL THEN NULL ' +
        'WHEN contains("c", chr(9)) OR contains("c", chr(13)) ' +
        "OR left(\"c\", 1) IN ('=', '+', '-', '@', chr(9), chr(13)) " +
        'THEN chr(39) || "c" ELSE "c" END',
    )
  })

  it('applies the CSV guard to VARCHAR columns of both branch kinds, export-only', () => {
    const ops: EditOp[] = [
      {
        kind: 'cell-set',
        rowId: rid('base:b1#0'),
        column: 'label',
        value: { kind: 'string', value: '=SUM(A1:A2)' },
      },
      {
        kind: 'row-insert',
        rowId: rid('ins:o1#0'),
        position: { kind: 'start' },
        values: new Map([['label', { kind: 'string', value: '-1+1' }]]),
      },
    ]
    const csv = composeSourceSql(compositionFor(ops), {
      withRowIds: false,
      sanitizeCsv: true,
      withKey: true,
    })
    // Base branch: the edited cell is guarded…
    expect(csv).toContain(
      "WHEN contains(CASE WHEN assay_overlay_ord = 0 THEN CAST('=SUM(A1:A2)' AS VARCHAR)",
    )
    // …and the inserted bait cell is guarded too.
    expect(csv).toContain("WHEN contains(CAST('-1+1' AS VARCHAR)")
    // Non-VARCHAR columns are never guarded.
    expect(csv).not.toContain('contains(CAST(NULL AS BIGINT)')
    // The plain window path never guards.
    const plain = composeSourceSql(compositionFor(ops), {
      withRowIds: false,
      sanitizeCsv: false,
      withKey: true,
    })
    expect(plain).not.toContain('chr(9)')
  })
})

describe('composeOverlayExportSql — deterministic COPY options', () => {
  it('composes COPY with the pinned per-format options', () => {
    const composition = compositionFor([])
    expect(composeOverlayExportSql(composition, 'parquet', 'assay-export-1')).toBe(
      'COPY (SELECT "id", "label" FROM (SELECT "id" AS "id", "label" AS "label" FROM ' +
        '(SELECT "id", "label", (row_number() OVER () - 1) AS assay_overlay_ord FROM "assay_t1"))) ' +
        "TO 'assay-export-1' (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 122880)",
    )
    expect(composeOverlayExportSql(composition, 'csv', 'assay-export-2')).toContain(
      "TO 'assay-export-2' (FORMAT CSV, HEADER true, DELIMITER ',', QUOTE '\"', ESCAPE '\"')",
    )
    expect(composeOverlayExportSql(composition, 'jsonl', 'assay-export-3')).toContain(
      "TO 'assay-export-3' (FORMAT JSON, ARRAY false)",
    )
    expect(composeOverlayExportSql(composition, 'json', 'assay-export-4')).toContain(
      "TO 'assay-export-4' (FORMAT JSON, ARRAY true)",
    )
  })

  it('exports in effective order with the sanitization guard for csv only', () => {
    const ops: EditOp[] = [
      {
        kind: 'cell-set',
        rowId: rid('base:b1#0'),
        column: 'label',
        value: { kind: 'string', value: '=SUM(A1:A2)' },
      },
      {
        kind: 'row-insert',
        rowId: rid('ins:o1#0'),
        position: { kind: 'start' },
        values: new Map([['id', { kind: 'number', value: 9 }]]),
      },
    ]
    const composition = compositionFor(ops)
    const csv = composeOverlayExportSql(composition, 'csv', 'e1')
    expect(csv).toContain('ORDER BY "assay_key"')
    expect(csv).toContain('chr(39)')
    const parquet = composeOverlayExportSql(composition, 'parquet', 'e2')
    expect(parquet).toContain('ORDER BY "assay_key"')
    expect(parquet).not.toContain('chr(39)')
  })

  it('returns null for arrow (streamed path) and the identical SELECT on demand', () => {
    const composition = compositionFor([])
    expect(composeOverlayExportSql(composition, 'arrow', 'e3')).toBeNull()
  })

  it('maps each format to its extension', () => {
    expect(exportFileExtension('parquet')).toBe('parquet')
    expect(exportFileExtension('jsonl')).toBe('jsonl')
    expect(exportFileExtension('arrow')).toBe('arrow')
  })
})
