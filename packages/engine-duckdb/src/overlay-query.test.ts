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
  composeOverlayCastCheckSql,
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
import { EngineTypeError } from './type-expr'

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

describe('overlay composition — edits on inserted rows merge into the insert branch (m4-2b)', () => {
  it('projects the folded cell-set value instead of the insert value or NULL', () => {
    // The m4-2b defect: the insert carried no `label` and the composer read
    // `InsertedRowRecord.values` only, so it emitted `CAST(NULL AS VARCHAR)
    // AS "label"` and silently dropped the edit. The merged value must win.
    const ops: EditOp[] = [
      {
        kind: 'row-insert',
        rowId: rid('ins:o1#0'),
        position: { kind: 'start' },
        values: new Map([['id', { kind: 'number', value: 1 }]]),
      },
      {
        kind: 'cell-set',
        rowId: rid('ins:o1#0'),
        column: 'label',
        value: { kind: 'string', value: 'edited' },
      },
    ]
    const sql = composeSourceSql(compositionFor(ops), {
      withRowIds: false,
      sanitizeCsv: false,
      withKey: true,
    })
    expect(sql).toContain('CAST(1 AS BIGINT) AS "id", CAST(\'edited\' AS VARCHAR) AS "label"')
    expect(sql).not.toContain('CAST(NULL AS VARCHAR) AS "label"')
  })

  it('lets the edit win over the insert value on the same column', () => {
    const ops: EditOp[] = [
      {
        kind: 'row-insert',
        rowId: rid('ins:o1#0'),
        position: { kind: 'start' },
        values: new Map([
          ['id', { kind: 'number', value: 1 }],
          ['label', { kind: 'string', value: 'inserted' }],
        ]),
      },
      {
        kind: 'cell-set',
        rowId: rid('ins:o1#0'),
        column: 'label',
        value: { kind: 'string', value: 'edited' },
      },
    ]
    const sql = composeSourceSql(compositionFor(ops), {
      withRowIds: false,
      sanitizeCsv: false,
      withKey: true,
    })
    expect(sql).toContain('CAST(\'edited\' AS VARCHAR) AS "label"')
    expect(sql).not.toContain('CAST(\'inserted\' AS VARCHAR) AS "label"')
  })

  it('falls back to the insert value when the edit is reverted', () => {
    // `cell-revert` deletes the fold entry (`no state.edits` entry left), so
    // the insert value stands again at this fold position — exactly what
    // `overlayEdit` returns for the reverted cell.
    const ops: EditOp[] = [
      {
        kind: 'row-insert',
        rowId: rid('ins:o1#0'),
        position: { kind: 'start' },
        values: new Map([
          ['id', { kind: 'number', value: 1 }],
          ['label', { kind: 'string', value: 'inserted' }],
        ]),
      },
      {
        kind: 'cell-set',
        rowId: rid('ins:o1#0'),
        column: 'label',
        value: { kind: 'string', value: 'edited' },
      },
      { kind: 'cell-revert', rowId: rid('ins:o1#0'), column: 'label' },
    ]
    const sql = composeSourceSql(compositionFor(ops), {
      withRowIds: false,
      sanitizeCsv: false,
      withKey: true,
    })
    expect(sql).toContain('CAST(\'inserted\' AS VARCHAR) AS "label"')
    expect(sql).not.toContain("CAST('edited' AS VARCHAR)")
  })

  it('keeps the edit on the renamed column after a column-rename', () => {
    // `column-rename` re-keys `state.edits` AND `record.values`, so the merge
    // that reads the effective column name follows the rename.
    const ops: EditOp[] = [
      {
        kind: 'row-insert',
        rowId: rid('ins:o1#0'),
        position: { kind: 'start' },
        values: new Map([
          ['id', { kind: 'number', value: 1 }],
          ['label', { kind: 'string', value: 'inserted' }],
        ]),
      },
      {
        kind: 'cell-set',
        rowId: rid('ins:o1#0'),
        column: 'label',
        value: { kind: 'string', value: 'edited' },
      },
      { kind: 'column-rename', from: 'label', to: 'label_v2' },
    ]
    const sql = composeSourceSql(compositionFor(ops), {
      withRowIds: false,
      sanitizeCsv: false,
      withKey: true,
    })
    expect(sql).toContain('CAST(\'edited\' AS VARCHAR) AS "label_v2"')
    expect(sql).not.toContain("CAST('inserted' AS VARCHAR)")
  })

  it('applies the CSV guard to the merged edit value', () => {
    const ops: EditOp[] = [
      {
        kind: 'row-insert',
        rowId: rid('ins:o1#0'),
        position: { kind: 'start' },
        values: new Map([['id', { kind: 'number', value: 1 }]]),
      },
      {
        kind: 'cell-set',
        rowId: rid('ins:o1#0'),
        column: 'label',
        value: { kind: 'string', value: '=1+1' },
      },
    ]
    const sql = composeSourceSql(compositionFor(ops), {
      withRowIds: false,
      sanitizeCsv: true,
      withKey: true,
    })
    expect(sql).toContain("contains(CAST('=1+1' AS VARCHAR)")
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

  it('classifies every textual alias as string-like so the CSV guard covers a TEXT cast (m4-2 fix)', () => {
    // A `column-cast` to DuckDB's TEXT alias sets the EFFECTIVE type to TEXT
    // (DESCRIBE canonicalizes it back to VARCHAR). An exact-`'VARCHAR'`
    // check skipped the guard here — the m4-2 review's finding 2.
    for (const alias of [
      'TEXT',
      'STRING',
      'CHAR(2)',
      'BPCHAR',
      'VARCHAR(20)',
      'CHARACTER VARYING',
    ]) {
      const ops: EditOp[] = [
        {
          kind: 'cell-set',
          rowId: rid('base:b1#0'),
          column: 'label',
          value: { kind: 'string', value: '=1+1' },
        },
        { kind: 'column-cast', column: 'label', targetType: alias },
      ]
      const csv = composeSourceSql(compositionFor(ops), {
        withRowIds: false,
        sanitizeCsv: true,
        withKey: false,
      })
      expect(csv, alias).toContain('chr(39)')
      expect(csv, alias).toContain(`AS ${alias}`)
    }
    // A numeric cast is not guarded (the guard would break the rendering).
    const numericBase: OverlayBase = {
      baseAnchor: 'b1',
      overlayAnchor: 'o1',
      columns: [{ name: 'id', type: 'BIGINT' }],
      baseRowCount: 3,
    }
    const numeric = composeSourceSql(
      {
        viewName: 'assay_t1',
        base: numericBase,
        state: foldOverlay(numericBase, [
          { kind: 'column-cast', column: 'id', targetType: 'DOUBLE' },
        ]).state,
      },
      { withRowIds: false, sanitizeCsv: true, withKey: false },
    )
    expect(numeric).not.toContain('chr(39)')
  })

  it('leaves array columns unguarded while still guarding scalar text (m4-2 fix round 2)', () => {
    // The second fix-round review: `VARCHAR[]`/`VARCHAR[3]` matched the old
    // exact-family check, so the CSV guard wrapped an array in `left()` and
    // DuckDB rejected the export with a Binder Error. Arrays must never get
    // scalar string functions; only a SCALAR textual column does.
    const arrayBase: OverlayBase = {
      baseAnchor: 'b1',
      overlayAnchor: 'o1',
      columns: [
        { name: 'id', type: 'BIGINT' },
        { name: 'note', type: 'VARCHAR' },
        { name: 'tags', type: 'VARCHAR[]' },
        { name: 'codes', type: 'VARCHAR[]' },
        { name: 'aliases', type: 'STRING[]' },
      ],
      baseRowCount: 2,
    }
    const ops: EditOp[] = [
      { kind: 'column-cast', column: 'codes', targetType: 'VARCHAR[3]' },
      { kind: 'column-cast', column: 'aliases', targetType: 'VARCHAR[]' },
      {
        kind: 'cell-set',
        rowId: rid('base:b1#0'),
        column: 'note',
        value: { kind: 'string', value: '=1+1' },
      },
    ]
    const state = foldOverlay(arrayBase, ops).state
    const csv = composeSourceSql(
      { viewName: 'assay_t1', base: arrayBase, state },
      { withRowIds: false, sanitizeCsv: true, withKey: false },
    )
    // The scalar bait is guarded…
    expect(csv).toContain('chr(39)')
    // …exactly once (one scalar guard): no array expression is wrapped.
    expect(csv.match(/\bleft\(/g)?.length).toBe(1)
    expect(csv).not.toContain('contains("tags"')
    expect(csv).not.toContain('contains(CAST("codes"')
    expect(csv).not.toContain('contains(CAST("aliases"')
    // The array casts still compose verbatim.
    expect(csv).toContain('CAST("codes" AS VARCHAR[3])')
    expect(csv).toContain('CAST("aliases" AS VARCHAR[])')
  })

  it('pins the text-value literal escaping (single quotes and backslashes)', () => {
    // `text` becomes CAST('<escaped>' AS <type>); DuckDB string literals use
    // '' for a quote and treat backslashes literally, so only quotes need
    // doubling (pinned against the pinned DuckDB CLI 1.5.5).
    expect(cellLiteralSql({ kind: 'text', text: "a\\b'c" }, 'VARCHAR')).toBe(
      "CAST('a\\b''c' AS VARCHAR)",
    )
    expect(cellLiteralSql({ kind: 'text', text: "'); DROP TABLE t; --" }, 'TEXT')).toBe(
      "CAST('''); DROP TABLE t; --' AS TEXT)",
    )
    expect(cellLiteralSql({ kind: 'string', value: 'back\\slash' }, 'TEXT')).toBe(
      "CAST('back\\slash' AS TEXT)",
    )
  })
})

describe('composeOverlayCastCheckSql — the m4-4b validate-before-commit check', () => {
  it('composes the early-exit existence shape over the plain base relation', () => {
    expect(composeOverlayCastCheckSql(compositionFor([]), 'label', 'BIGINT')).toBe(
      'SELECT 1 FROM (SELECT "id" AS "id", "label" AS "label" FROM ' +
        '(SELECT "id", "label", (row_number() OVER () - 1) AS assay_overlay_ord FROM "assay_t1")) ' +
        'WHERE "label" IS NOT NULL AND TRY_CAST("label" AS BIGINT) IS NULL LIMIT 1',
    )
  })

  it('quotes the effective column and interpolates a validated target type verbatim', () => {
    const sql = composeOverlayCastCheckSql(compositionFor([]), 'id', 'DECIMAL(10, 2)')
    expect(sql).toContain('WHERE "id" IS NOT NULL AND TRY_CAST("id" AS DECIMAL(10, 2)) IS NULL')
    // The `SELECT 1` projection: no dataset value can leave the engine.
    expect(sql.startsWith('SELECT 1 FROM (')).toBe(true)
    expect(sql.endsWith('LIMIT 1')).toBe(true)
  })

  it('uses the renamed effective column and scans edits, inserts and casts (m4-2b/m4-4b)', () => {
    const ops: EditOp[] = [
      { kind: 'row-delete', rowId: rid('base:b1#1') },
      {
        kind: 'cell-set',
        rowId: rid('base:b1#0'),
        column: 'label',
        value: { kind: 'string', value: 'not-a-number' },
      },
      {
        kind: 'row-insert',
        rowId: rid('ins:o1#0'),
        position: { kind: 'start' },
        values: new Map([['id', { kind: 'number', value: 9 }]]),
      },
      { kind: 'column-rename', from: 'label', to: 'label_v2' },
    ]
    const sql = composeOverlayCastCheckSql(compositionFor(ops), 'label_v2', 'BIGINT')
    // Renamed projection + the edited CASE arm + the live insert branch.
    expect(sql).toContain(
      `CASE WHEN assay_overlay_ord = 0 THEN CAST('not-a-number' AS VARCHAR) ELSE "label" END AS "label_v2"`,
    )
    expect(sql).toContain('WHERE assay_overlay_ord NOT IN (1)')
    expect(sql).toContain('UNION ALL')
    expect(sql).toContain('WHERE "label_v2" IS NOT NULL AND TRY_CAST("label_v2" AS BIGINT) IS NULL')
  })

  it('applies TRY_CAST to the un-cast value when the column already has a prior cast (m4-4b fix)', () => {
    // The domain collapses cast chains: committing a further cast after this
    // state composes `CAST(base AS target)`, NOT
    // `TRY_CAST(CAST(base AS prior) AS target)`. The check must therefore
    // predicate on the un-cast source projection; a revert to
    // `valueProjection: 'effective'` reintroduces `CAST("label" AS BOOLEAN)`
    // and fails this pin.
    const composition = compositionFor([
      { kind: 'column-cast', column: 'label', targetType: 'BOOLEAN' },
    ])
    const sql = composeOverlayCastCheckSql(composition, 'label', 'BIGINT')
    expect(sql).not.toContain('CAST("label" AS BOOLEAN)')
    expect(sql).toContain('"label" AS "label"')
    expect(sql).toContain('WHERE "label" IS NOT NULL AND TRY_CAST("label" AS BIGINT) IS NULL')
  })

  it('renders a prior-cast edit arm at the base type so the outer TRY_CAST matches the commit (m4-4b fix)', () => {
    const composition = compositionFor([
      {
        kind: 'cell-set',
        rowId: rid('base:b1#0'),
        column: 'label',
        value: { kind: 'text', text: 'true' },
      },
      { kind: 'column-cast', column: 'label', targetType: 'BOOLEAN' },
    ])
    const sql = composeOverlayCastCheckSql(composition, 'label', 'INTEGER')
    // Edit arm carried at the base type (VARCHAR), not the prior cast type
    // (BOOLEAN): the committed cast would apply INTEGER directly to 'true'.
    expect(sql).toContain(
      `CASE WHEN assay_overlay_ord = 0 THEN CAST('true' AS VARCHAR) ELSE "label" END`,
    )
    expect(sql).not.toContain("CAST('true' AS BOOLEAN)")
    expect(sql).toContain('TRY_CAST("label" AS INTEGER)')
  })

  it('renders a prior-cast insert literal at the base type (m4-4b fix)', () => {
    const composition = compositionFor([
      { kind: 'column-cast', column: 'label', targetType: 'BOOLEAN' },
      {
        kind: 'row-insert',
        rowId: rid('ins:o1#0'),
        position: { kind: 'start' },
        values: new Map([['label', { kind: 'text', text: 'true' }]]),
      },
    ])
    const sql = composeOverlayCastCheckSql(composition, 'label', 'INTEGER')
    expect(sql).toContain(`CAST('true' AS VARCHAR) AS "label"`)
    expect(sql).not.toContain(`CAST('true' AS BOOLEAN)`)
  })

  it('leaves a no-prior-cast column unaffected by a different column prior cast (m4-4b)', () => {
    const composition = compositionFor([
      { kind: 'column-cast', column: 'id', targetType: 'VARCHAR' },
    ])
    const sql = composeOverlayCastCheckSql(composition, 'label', 'BIGINT')
    expect(sql).toContain('TRY_CAST("label" AS BIGINT)')
    // `label` carries no cast of its own, and `id`'s prior cast never leaks
    // into `label`'s value expression.
    expect(sql).not.toContain('CAST("label" AS VARCHAR)')
  })

  it('rejects an unknown effective column before composing any SQL', () => {
    expect(() =>
      composeOverlayCastCheckSql(compositionFor([]), 'no_such_column', 'BIGINT'),
    ).toThrow('unknown overlay column: no_such_column')
    // A pre-rename name is not effective once the rename is folded.
    const composition = compositionFor([{ kind: 'column-rename', from: 'label', to: 'label_v2' }])
    expect(() => composeOverlayCastCheckSql(composition, 'label', 'BIGINT')).toThrow(
      'unknown overlay column: label',
    )
  })

  it('throws a typed EngineTypeError for an invalid target spelling (no SQL built)', () => {
    for (const targetType of ['VARCHAR()', 'DECIMAL(1,2,3)', 'BIGINT; DROP TABLE t']) {
      expect(() => composeOverlayCastCheckSql(compositionFor([]), 'label', targetType)).toThrow(
        EngineTypeError,
      )
    }
    // The validator runs before the column check, so a bad type never leaks a
    // partially-built statement even with a valid column.
    expect(() => composeOverlayCastCheckSql(compositionFor([]), 'id', 'NOPE(')).toThrow(
      EngineTypeError,
    )
  })

  it('validates the effective schema types (defence in depth, like the other composers)', () => {
    const hostile: OverlayBase = {
      ...BASE,
      columns: [
        { name: 'id', type: 'BIGINT' },
        { name: 'label', type: 'VARCHAR) ; DROP TABLE t; --' },
      ],
    }
    const composition = {
      viewName: 'assay_t1',
      base: hostile,
      state: foldOverlay(hostile, []).state,
    }
    expect(() => composeOverlayCastCheckSql(composition, 'label', 'BIGINT')).toThrow(
      EngineTypeError,
    )
  })
})

describe('overlay composition — hostile type expressions produce no SQL (m4-2 fix)', () => {
  const PAYLOAD = 'VARCHAR) AS "c" FROM (...) ); CREATE TABLE assay_injected AS SELECT 31337; --'

  it('throws a typed EngineTypeError before composing a hostile column-cast target', () => {
    const state = stateFor([{ kind: 'column-cast', column: 'label', targetType: PAYLOAD }])
    const composition = { viewName: 'assay_t1', base: BASE, state }
    expect(() =>
      composeSourceSql(composition, { withRowIds: false, sanitizeCsv: false, withKey: false }),
    ).toThrow(EngineTypeError)
    expect(() => composeOverlaySchemaSql(composition)).toThrow(EngineTypeError)
    expect(() => composeOverlayWindowSql({ ...composition, limit: 1, offset: 0 })).toThrow(
      EngineTypeError,
    )
    expect(() => composeOverlayCountSql(composition)).toThrow(EngineTypeError)
    expect(() => composeOverlayExportSql(composition, 'csv', 'e1')).toThrow(EngineTypeError)
  })

  it('throws before composing a hostile base column type', () => {
    const hostile: OverlayBase = {
      ...BASE,
      columns: [
        { name: 'id', type: 'BIGINT' },
        { name: 'label', type: PAYLOAD },
      ],
    }
    const composition = {
      viewName: 'assay_t1',
      base: hostile,
      state: foldOverlay(hostile, []).state,
    }
    expect(() =>
      composeSourceSql(composition, { withRowIds: false, sanitizeCsv: true, withKey: false }),
    ).toThrow(EngineTypeError)
  })

  it('cellLiteralSql validates its effective type (last-line defence)', () => {
    expect(() => cellLiteralSql({ kind: 'null' }, PAYLOAD)).toThrow(EngineTypeError)
    expect(() => cellLiteralSql({ kind: 'string', value: 'x' }, 'BIGINT; DROP TABLE t')).toThrow(
      EngineTypeError,
    )
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
