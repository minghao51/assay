// SPDX-License-Identifier: AGPL-3.0-or-later

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
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/** Test-side branded-id constructor for canonical literal ids. */
const rid = (text: string): RowId => text as RowId
import {
  cellLiteralRawSql,
  cellLiteralSql,
  composeOverlayCastCheckSql,
  composeOverlayCountSql,
  composeOverlaySchemaSql,
  composeOverlayWindowSql,
  composeSourceSql,
  formulaInjectionGuardSql,
  insertSortKeys,
  MAX_OVERLAY_LIVE_INSERT_BRANCHES,
  OverlayLiveInsertLimitError,
  OVERLAY_ROW_ID_COLUMN,
  RESERVED_OVERLAY_COLUMN_NAMES,
} from './overlay-query'
import {
  composeOverlayExportSelectSql,
  composeOverlayExportSql,
  exportFileExtension,
} from './export-query'
import { EngineTypeError } from './type-expr'
import { quotedIdentifier, sqlStringLiteral } from './format-view'

/** The pinned DuckDB CLI for the behavioural probes (skipped when absent). */
const DUCKDB_CLI = process.env['DUCKDB'] ?? '/tmp/duckdb'
const hasDuckDbCli = existsSync(DUCKDB_CLI)

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

  it('composes the wrapped DESCRIBE over the composed effective relation (D16a)', () => {
    // D16(a) accepted shape: the schema op describes an OUTER projection over
    // `composeSourceSql`'s union (withRowIds/withKey/sanitizeCsv off — the
    // ordinal is created inside the base branch and never projected), so it
    // can only describe a relation the materializing ops produce. Empty
    // overlay byte pin (the probe's §1.1 shape; the old unwrapped pin was
    // rewritten, not deleted):
    expect(composeOverlaySchemaSql(compositionFor([]))).toBe(
      'DESCRIBE SELECT "id" AS "id", "label" AS "label" FROM ' +
        '(SELECT "id" AS "id", "label" AS "label" FROM ' +
        '(SELECT "id", "label", (row_number() OVER () - 1) AS assay_overlay_ord FROM "assay_t1"))',
    )
  })

  it('keeps the schema op machinery-free: no row-id/key columns, CSV guard, or sanitization', () => {
    const withInsert = compositionFor([
      {
        kind: 'row-insert',
        rowId: rid('ins:o1#0'),
        position: { kind: 'start' },
        values: new Map([
          ['id', { kind: 'number', value: 9 }],
          ['label', { kind: 'string', value: 'ins' }],
        ]),
      },
      {
        kind: 'cell-set',
        rowId: rid('base:b1#0'),
        column: 'label',
        value: { kind: 'string', value: 'edited' },
      },
    ])
    const sql = composeOverlaySchemaSql(withInsert)
    expect(sql).toContain('UNION ALL')
    expect(sql).toContain('CAST(9 AS BIGINT) AS "id"')
    expect(sql).toContain('CAST(\'ins\' AS VARCHAR) AS "label"')
    for (const machinery of ['assay_row_id', 'assay_key', 'hex(', 'chr(39)']) {
      expect(sql, machinery).not.toContain(machinery)
    }
    // No live inserts ⇒ no union.
    expect(composeOverlaySchemaSql(compositionFor([]))).not.toContain('UNION ALL')
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

  it('rejects a reserved name on a BASE column even when an overlay renames it away (AR-E4)', () => {
    // The defect: the assertion ran on `state.columns` only, so a base column
    // named exactly the ordinal alias (`assay_overlay_ord`) that a rename
    // moved away escaped the check — the base branch would still project it
    // and shadow the generated ordinal, corrupting the edit CASE arms.
    const reservedBase: OverlayBase = {
      ...BASE,
      columns: [
        { name: 'assay_overlay_ord', type: 'BIGINT' },
        { name: 'label', type: 'VARCHAR' },
      ],
    }
    const ops: EditOp[] = [{ kind: 'column-rename', from: 'assay_overlay_ord', to: 'ord_v2' }]
    const state = foldOverlay(reservedBase, ops).state
    // The effective name is not reserved; only the BASE name trips the check.
    expect(state.columns.map((column) => column.name)).toEqual(['ord_v2', 'label'])
    const composition = { viewName: 'assay_t1', base: reservedBase, state }
    expect(() => composeOverlaySchemaSql(composition)).toThrow(/reserved/)
    expect(() => composeOverlayWindowSql({ ...composition, limit: 1, offset: 0 })).toThrow(
      /reserved/,
    )
    expect(() => composeOverlayCountSql(composition)).toThrow(/reserved/)
    expect(() => composeOverlayExportSql(composition, 'csv', 'e1')).toThrow(/reserved/)
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

describe('overlay composition — live-insert branch cap (PT-Q q-6)', () => {
  const CAP = MAX_OVERLAY_LIVE_INSERT_BRANCHES
  /** `count` live inserts anchored at the start, seq unique per row. */
  function inserts(count: number): EditOp[] {
    return Array.from({ length: count }, (_, index) => ({
      kind: 'row-insert' as const,
      rowId: rid(`ins:o1#${index}`),
      position: { kind: 'start' as const },
      values: new Map([
        ['id', { kind: 'number' as const, value: index }],
        ['label', { kind: 'string' as const, value: `SENTINEL_VALUE_${index}` }],
      ]),
    }))
  }

  it('composes exactly at the cap (the last admitted branch count)', () => {
    const sql = composeSourceSql(compositionFor(inserts(CAP)), {
      withRowIds: false,
      sanitizeCsv: false,
      withKey: true,
    })
    // One base branch + one branch per live insert.
    expect(sql.split(' UNION ALL ')).toHaveLength(CAP + 1)
  })

  it('throws a typed, value-free error one branch over the cap (window)', () => {
    const ops = inserts(CAP + 1)
    let thrown: unknown
    try {
      composeOverlayWindowSql({ ...compositionFor(ops), limit: 10, offset: 0 })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(OverlayLiveInsertLimitError)
    // The exact, value-free text: names only the engine's own branch cap and
    // the remedy — no table name, SQL, cell value, or user row count.
    expect((thrown as Error).message).toBe(
      'the edited view has more live inserts than the engine composes in one window (limit 500 live-insert branches); export the edits to a new file and re-open it to continue',
    )
    for (const secret of ['SENTINEL_VALUE', 'assay_t1', BASE.baseAnchor]) {
      expect((thrown as Error).message).not.toContain(secret)
    }
  })

  it('enforces the same budget before composing the cast check', () => {
    expect(() =>
      composeOverlayCastCheckSql(compositionFor(inserts(CAP + 1)), 'id', 'VARCHAR'),
    ).toThrowError(OverlayLiveInsertLimitError)
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

  it('normalizes a user-entered -0 to +0 at the single literal boundary (-0 QoL)', () => {
    // `String(-0)` is `'0'`, so the SQL literal, the raw cast-check literal,
    // and every export format (all read the materialized engine value) agree
    // on +0. This is the ONE normalization point; no per-format divergence.
    expect(cellLiteralSql({ kind: 'number', value: -0 }, 'DOUBLE')).toBe('CAST(0 AS DOUBLE)')
    expect(cellLiteralRawSql({ kind: 'number', value: -0 })).toBe('0')
  })

  it('renders a raw value literal with no type wrapper for the cast check (m4-4b round 3)', () => {
    // The check applies `TRY_CAST(<raw literal> AS target)`; a wrapper cast to
    // the base column type (`CAST('hello' AS DOUBLE)`) could throw before the
    // TRY_CAST and disagree with the committed `CAST('hello' AS target)`.
    expect(cellLiteralRawSql({ kind: 'null' })).toBe('NULL')
    expect(cellLiteralRawSql({ kind: 'boolean', value: false })).toBe('FALSE')
    expect(cellLiteralRawSql({ kind: 'number', value: 1.5 })).toBe('1.5')
    expect(cellLiteralRawSql({ kind: 'string', value: "it's" })).toBe("'it''s'")
    expect(cellLiteralRawSql({ kind: 'text', text: 'hello' })).toBe("'hello'")
    expect(() => cellLiteralRawSql({ kind: 'number', value: Number.NaN })).toThrow(/materialized/)
  })

  it('guards leading =, +, -, @ and embedded tab/LF/CR, passing NULL through', () => {
    const guard = formulaInjectionGuardSql('"c"')
    // The exact composed bytes (CLI-verified semantics against DuckDB 1.5.5).
    expect(guard).toBe(
      'CASE WHEN "c" IS NULL THEN NULL ' +
        'WHEN contains("c", chr(9)) OR contains("c", chr(10)) OR contains("c", chr(13)) ' +
        "OR left(\"c\", 1) IN ('=', '+', '-', '@', chr(9), chr(10), chr(13)) " +
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

  it('hex-encodes scalar BLOB columns on CSV export (AR-E1)', () => {
    // The critical bypass: DuckDB's CSV writer emits BLOB bytes raw, so
    // `COPY (SELECT '=cmd|@SUM(1+1)'::BLOB …) TO … (FORMAT CSV)` writes a
    // live formula-leading cell, and the string guard's `contains`/`left`
    // cannot touch a BLOB (Binder Error). Hex is `[0-9A-F]`-only and cannot
    // be read as a formula. The cast-to-BLOB overlay leg and a BLOB-typed
    // insert value are both covered.
    const blobBase: OverlayBase = {
      baseAnchor: 'b1',
      overlayAnchor: 'o1',
      columns: [
        { name: 'id', type: 'BIGINT' },
        { name: 'payload', type: 'VARCHAR' },
      ],
      baseRowCount: 2,
    }
    const ops: EditOp[] = [
      { kind: 'column-cast', column: 'payload', targetType: 'BLOB' },
      {
        kind: 'row-insert',
        rowId: rid('ins:o1#0'),
        position: { kind: 'start' },
        values: new Map([['payload', { kind: 'string', value: '=cmd|@SUM(1+1)' }]]),
      },
    ]
    const state = foldOverlay(blobBase, ops).state
    const composition = { viewName: 'assay_t1', base: blobBase, state }
    const csv = composeSourceSql(composition, {
      withRowIds: false,
      sanitizeCsv: true,
      withKey: false,
    })
    // Base branch: the cast-to-BLOB column is hex-encoded…
    expect(csv).toContain('hex(CAST("payload" AS BLOB)) AS "payload"')
    // …and the BLOB-typed insert value is hex-encoded on the insert branch.
    expect(csv).toContain("hex(CAST('=cmd|@SUM(1+1)' AS BLOB))")
    // BLOB is not treated as text: no string guard is applied to it.
    expect(csv).not.toContain('contains(hex(')
    expect(csv).not.toContain("contains(CAST('=cmd|@SUM(1+1)' AS BLOB)")
    // Non-CSV exports keep the raw BLOB (only CSV is a spreadsheet surface).
    const parquet = composeSourceSql(composition, {
      withRowIds: false,
      sanitizeCsv: false,
      withKey: false,
    })
    expect(parquet).not.toContain('hex(')
    // And the composed COPY SELECT is the exported content for CSV.
    expect(composeOverlayExportSelectSql(composition, 'csv')).toContain(
      'hex(CAST("payload" AS BLOB))',
    )
  })

  it('hex-encodes an overlay-free base BLOB column on CSV export (AR-E1)', () => {
    // The overlay-free export takes the DESCRIBE type verbatim; a Parquet
    // BYTE_ARRAY inferred as BLOB reaches the guard with an empty state and
    // must be hex-encoded exactly like an overlay column.
    const blobBase: OverlayBase = {
      baseAnchor: 'b1',
      overlayAnchor: 'o1',
      columns: [{ name: 'payload', type: 'BLOB' }],
      baseRowCount: 1,
    }
    const composition = {
      viewName: 'assay_t1',
      base: blobBase,
      state: foldOverlay(blobBase, []).state,
    }
    const csv = composeOverlayExportSql(composition, 'csv', 'e1')
    expect(csv).toContain('hex("payload") AS "payload"')
    const parquet = composeOverlayExportSql(composition, 'parquet', 'e2')
    expect(parquet).not.toContain('hex(')
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

describe('cell text well-formedness guard (au3-13)', () => {
  const LONE_HIGH = '\uD800'
  const LONE_LOW = '\uDC00'
  const PAIR = '\u{1F600}'
  /** A distinctive marker to detect value-bearing error messages. */
  const SENTINEL = 'AU3SECRET'

  it('rejects an unpaired surrogate in a string cell-set, value-free', () => {
    const composition = compositionFor([
      {
        kind: 'cell-set',
        rowId: rid('base:b1#0'),
        column: 'label',
        value: { kind: 'string', value: `${SENTINEL}${LONE_HIGH}payload` },
      },
    ])
    expect(() => composeOverlayWindowSql({ ...composition, limit: 10, offset: 0 })).toThrow(
      /unpaired surrogate/,
    )
    expect(() => composeOverlayExportSelectSql(composition, 'csv')).toThrow(/unpaired surrogate/)
    // The cast check shares the guard, so a bad edit cannot pass validation.
    expect(() => composeOverlayCastCheckSql(composition, 'label', 'VARCHAR')).toThrow(
      /unpaired surrogate/,
    )

    // Value-free (ADR 0025): the message names the defect, never the cell text.
    let message = ''
    try {
      composeOverlayWindowSql({ ...composition, limit: 10, offset: 0 })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).not.toContain(LONE_HIGH)
    expect(message).not.toContain(SENTINEL)
    expect(message).not.toContain('payload')
  })

  it('rejects a lone low surrogate and an unpaired high surrogate at the end', () => {
    expect(() => cellLiteralSql({ kind: 'string', value: `x${LONE_LOW}` }, 'VARCHAR')).toThrow(
      /unpaired surrogate/,
    )
    expect(() => cellLiteralSql({ kind: 'string', value: `x${LONE_HIGH}` }, 'VARCHAR')).toThrow(
      /unpaired surrogate/,
    )
    // The raw literal builder used by the cast check is guarded identically.
    expect(() => cellLiteralRawSql({ kind: 'text', text: `x${LONE_LOW}` })).toThrow(
      /unpaired surrogate/,
    )
  })

  it('composes well-formed astral pairs and BMP strings unchanged (byte-stability)', () => {
    expect(cellLiteralSql({ kind: 'string', value: PAIR }, 'VARCHAR')).toBe(
      `CAST('${PAIR}' AS VARCHAR)`,
    )
    expect(cellLiteralSql({ kind: 'string', value: 'plain \u00e9 BMP' }, 'VARCHAR')).toBe(
      "CAST('plain \u00e9 BMP' AS VARCHAR)",
    )
    expect(cellLiteralRawSql({ kind: 'string', value: `a${PAIR}b` })).toBe(`'a${PAIR}b'`)
    // The pair survives the root-cause channel byte-for-byte.
    expect([...new TextEncoder().encode(PAIR)]).toEqual([0xf0, 0x9f, 0x98, 0x80])
  })

  it('leaves base-data passthrough untouched: a composition with no edits composes fine', () => {
    // The guard lives only in the user-value literal builders; a composition
    // projecting base columns directly never invokes it (a U+FFFD already in
    // source data is legitimate and never reaches the composer).
    expect(
      composeSourceSql(compositionFor([]), {
        withRowIds: false,
        sanitizeCsv: false,
        withKey: false,
      }),
    ).toBe(
      'SELECT "id" AS "id", "label" AS "label" FROM ' +
        '(SELECT "id", "label", (row_number() OVER () - 1) AS assay_overlay_ord FROM "assay_t1")',
    )
  })
})

describe('composeOverlayCastCheckSql — the m4-4b validate-before-commit check', () => {
  it('composes the early-exit existence shape over the raw base column', () => {
    expect(composeOverlayCastCheckSql(compositionFor([]), 'label', 'BIGINT')).toBe(
      'SELECT 1 FROM (SELECT "label", assay_overlay_ord FROM ' +
        '(SELECT "id", "label", (row_number() OVER () - 1) AS assay_overlay_ord FROM "assay_t1")) ' +
        'WHERE ("label" IS NOT NULL AND TRY_CAST("label" AS BIGINT) IS NULL) LIMIT 1',
    )
  })

  it('quotes the effective column and interpolates a validated target type verbatim', () => {
    const sql = composeOverlayCastCheckSql(compositionFor([]), 'id', 'DECIMAL(10, 2)')
    expect(sql).toContain('"id" IS NOT NULL AND TRY_CAST("id" AS DECIMAL(10, 2)) IS NULL')
    // The `SELECT 1` projection: no dataset value can leave the engine.
    expect(sql.startsWith('SELECT 1 FROM (')).toBe(true)
    expect(sql.endsWith('LIMIT 1')).toBe(true)
  })

  it('uses the renamed effective column and scans edits, tombstones and inserts (m4-2b/m4-4b)', () => {
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
        values: new Map([
          ['id', { kind: 'number', value: 9 }],
          ['label', { kind: 'string', value: 'also-bad' }],
        ]),
      },
      { kind: 'column-rename', from: 'label', to: 'label_v2' },
    ]
    const sql = composeOverlayCastCheckSql(compositionFor(ops), 'label_v2', 'BIGINT')
    // Renamed column: the tombstone filter, the edited-ordinal arm (raw
    // literal under its own TRY_CAST), the un-edited base arm, and the live
    // insert's raw merged value.
    expect(sql).toContain('WHERE assay_overlay_ord NOT IN (1)')
    expect(sql).toContain(
      `assay_overlay_ord = 0 AND 'not-a-number' IS NOT NULL AND TRY_CAST('not-a-number' AS BIGINT) IS NULL`,
    )
    expect(sql).toContain(
      `assay_overlay_ord NOT IN (0) AND "label" IS NOT NULL AND TRY_CAST("label" AS BIGINT) IS NULL`,
    )
    expect(sql).toContain(
      `SELECT 1 WHERE 'also-bad' IS NOT NULL AND TRY_CAST('also-bad' AS BIGINT) IS NULL`,
    )
    expect(sql).toContain('UNION ALL')
  })

  it('applies TRY_CAST to the un-cast value when the column already has a prior cast (m4-4b fix)', () => {
    // The domain collapses cast chains: committing a further cast after this
    // state composes `CAST(base AS target)`, NOT
    // `TRY_CAST(CAST(base AS prior) AS target)`. The check must therefore
    // predicate on the raw base value; a revert to the effective projection
    // reintroduces `CAST("label" AS BOOLEAN)` and fails this pin.
    const composition = compositionFor([
      { kind: 'column-cast', column: 'label', targetType: 'BOOLEAN' },
    ])
    const sql = composeOverlayCastCheckSql(composition, 'label', 'BIGINT')
    expect(sql).not.toContain('CAST("label" AS BOOLEAN)')
    expect(sql).toContain('"label" IS NOT NULL AND TRY_CAST("label" AS BIGINT) IS NULL')
  })

  it('renders a prior-cast edit arm as a raw literal under TRY_CAST (m4-4b round 3)', () => {
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
    // The committed cast applies INTEGER directly to the raw 'true' (the
    // prior BOOLEAN cast is collapsed away). The literal must reach the
    // check's TRY_CAST unwrapped: a `CAST('true' AS VARCHAR|BOOLEAN)` wrapper
    // would test a different value (round-3 finding).
    expect(sql).toContain(`'true' IS NOT NULL AND TRY_CAST('true' AS INTEGER) IS NULL`)
    expect(sql).not.toContain("CAST('true' AS VARCHAR)")
    expect(sql).not.toContain("CAST('true' AS BOOLEAN)")
  })

  it('renders a prior-cast insert literal as a raw literal under TRY_CAST (m4-4b round 3)', () => {
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
    expect(sql).toContain(
      `SELECT 1 WHERE 'true' IS NOT NULL AND TRY_CAST('true' AS INTEGER) IS NULL`,
    )
    expect(sql).not.toContain("CAST('true' AS VARCHAR)")
    expect(sql).not.toContain("CAST('true' AS BOOLEAN)")
    // The base arm still tests the raw base column.
    expect(sql).toContain('TRY_CAST("label" AS INTEGER)')
  })

  it('keeps a cross-type string edit on a DOUBLE base raw, matching the commit (reviewer repro)', () => {
    // Base `price DOUBLE`; a prior cast to VARCHAR then `cell-set 'hello'`
    // (valid for the VARCHAR effective column) then a pending cast. The old
    // source projection rendered `CAST('hello' AS DOUBLE)`, which throws
    // before the check's TRY_CAST while the committed `CAST('hello' AS TEXT)`
    // succeeds; for INTEGER the committed cast throws and the check must
    // answer true. Pins that no literal is hard-cast before its TRY_CAST.
    const priceBase: OverlayBase = {
      baseAnchor: 'b1',
      overlayAnchor: 'o1',
      columns: [{ name: 'price', type: 'DOUBLE' }],
      baseRowCount: 2,
    }
    const ops: EditOp[] = [
      { kind: 'column-cast', column: 'price', targetType: 'VARCHAR' },
      {
        kind: 'cell-set',
        rowId: rid('base:b1#0'),
        column: 'price',
        value: { kind: 'string', value: 'hello' },
      },
    ]
    const composition = {
      viewName: 'assay_t1',
      base: priceBase,
      state: foldOverlay(priceBase, ops).state,
    }
    const asText = composeOverlayCastCheckSql(composition, 'price', 'TEXT')
    expect(asText).not.toContain("CAST('hello' AS DOUBLE)")
    expect(asText).not.toContain("CAST('hello' AS VARCHAR)")
    expect(asText).toContain(`'hello' IS NOT NULL AND TRY_CAST('hello' AS TEXT) IS NULL`)
    expect(asText).toContain('TRY_CAST("price" AS TEXT)')
    const asInteger = composeOverlayCastCheckSql(composition, 'price', 'INTEGER')
    expect(asInteger).toContain(`TRY_CAST('hello' AS INTEGER) IS NULL`)
    expect(asInteger).not.toContain("CAST('hello' AS DOUBLE)")
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

/**
 * R1-C: the un-edited base arm is elided only when it is provably empty, so a
 * pre-commit `cell-set` value check composes **no per-row base predicate** (one
 * predicate per edit, plus the ordinal subquery and `LIMIT 1`) instead of a
 * column scan.
 *
 * The proof: the arm is `<base> IS NOT NULL AND TRY_CAST(<base> AS target) IS
 * NULL`, so it can fire only when a non-NULL base value does not convert to
 * `target`. When the folded effective column still has the base column's type
 * *and* the check targets that same type, every non-NULL base value already
 * has it — the arm is empty by construction. Only a pending cast (a
 * composition whose effective/target type differs from the base type) can make
 * base values fail, and those shapes keep the full scan.
 */
describe('composeOverlayCastCheckSql — the un-edited base arm is provably elided (R1-C)', () => {
  const DATED: OverlayBase = {
    baseAnchor: 'b1',
    overlayAnchor: 'o1',
    columns: [{ name: 'd', type: 'DATE' }],
    baseRowCount: 2,
  }
  const datedComposition = (ops: EditOp[]) => ({
    viewName: 'assay_t1',
    base: DATED,
    state: foldOverlay(DATED, ops).state,
  })
  const EDIT: EditOp = {
    kind: 'cell-set',
    rowId: rid('base:b1#0'),
    column: 'd',
    value: { kind: 'text', text: 'not-a-date' },
  }

  it('omits the base arm for an edited column whose effective type is the base type', () => {
    const sql = composeOverlayCastCheckSql(datedComposition([EDIT]), 'd', 'DATE')
    expect(sql).toBe(
      'SELECT 1 FROM (SELECT "d", assay_overlay_ord FROM ' +
        '(SELECT "d", (row_number() OVER () - 1) AS assay_overlay_ord FROM "assay_t1")) ' +
        "WHERE (assay_overlay_ord = 0 AND 'not-a-date' IS NOT NULL AND " +
        "TRY_CAST('not-a-date' AS DATE) IS NULL) LIMIT 1",
    )
    // Exactly one predicate, over the edit literal: no per-row base predicate
    // (`TRY_CAST("d" …)` / `NOT IN (…)`) is composed. The ordinal subquery and
    // `LIMIT 1` remain, so this bounds the predicate work, not the whole
    // statement's cost.
    expect(sql.match(/TRY_CAST\(/g)).toHaveLength(1)
    expect(sql).not.toContain('TRY_CAST("d"')
    expect(sql).not.toContain('assay_overlay_ord NOT IN (')
  })

  it('keeps the base arm when a prior cast makes the effective type differ from the base type', () => {
    const sql = composeOverlayCastCheckSql(
      datedComposition([
        {
          kind: 'cell-set',
          rowId: rid('base:b1#0'),
          column: 'd',
          value: { kind: 'text', text: '2020-01-01' },
        },
        { kind: 'column-cast', column: 'd', targetType: 'VARCHAR' },
      ]),
      'd',
      'DATE',
    )
    expect(sql).toBe(
      'SELECT 1 FROM (SELECT "d", assay_overlay_ord FROM ' +
        '(SELECT "d", (row_number() OVER () - 1) AS assay_overlay_ord FROM "assay_t1")) ' +
        "WHERE (assay_overlay_ord = 0 AND '2020-01-01' IS NOT NULL AND " +
        "TRY_CAST('2020-01-01' AS DATE) IS NULL) OR " +
        '(assay_overlay_ord NOT IN (0) AND "d" IS NOT NULL AND ' +
        'TRY_CAST("d" AS DATE) IS NULL) LIMIT 1',
    )
  })

  it('keeps the base arm when the column has no edits (the original base-column question)', () => {
    const sql = composeOverlayCastCheckSql(datedComposition([]), 'd', 'DATE')
    expect(sql).toBe(
      'SELECT 1 FROM (SELECT "d", assay_overlay_ord FROM ' +
        '(SELECT "d", (row_number() OVER () - 1) AS assay_overlay_ord FROM "assay_t1")) ' +
        'WHERE ("d" IS NOT NULL AND TRY_CAST("d" AS DATE) IS NULL) LIMIT 1',
    )
  })

  it('keeps the base arm for the cast pre-check (effective type is the base type, target differs)', () => {
    // The m4-4b cast pre-check composes over the *pre-cast* state, so the
    // effective type still equals the base type; only the target type is the
    // cast's. The arm must survive that shape — it is the check's whole point.
    const sql = composeOverlayCastCheckSql(datedComposition([EDIT]), 'd', 'VARCHAR')
    expect(sql).toContain('assay_overlay_ord NOT IN (0) AND "d" IS NOT NULL')
    expect(sql).toContain('TRY_CAST("d" AS VARCHAR) IS NULL')
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

describe('CSV export header guard (C1/S1)', () => {
  /** The documented trigger forms: leading =/+/−/@ and embedded tab/LF/CR. */
  const HOSTILE_NAMES = ['=SUM(A2:A3)', '+x', '-x', '@x', '\t=x', '\r=x', '\n=x'] as const
  /** The SQL alias a guarded header name must carry (`chr(39) || name`). */
  const guardedAlias = (name: string): string => ` AS ${sqlStringLiteral(`'${name}`)}`

  function hostileComposition(
    names: readonly string[],
    ops: EditOp[] = [],
  ): { viewName: string; base: OverlayBase; state: ReturnType<typeof stateFor> } {
    const base: OverlayBase = {
      baseAnchor: 'b1',
      overlayAnchor: 'o1',
      columns: names.map((name) => ({ name, type: 'VARCHAR' })),
      baseRowCount: 1,
    }
    return { viewName: 'assay_t1', base, state: foldOverlay(base, ops).state }
  }

  it('apostrophe-guards every hostile CSV column name as the exported header alias', () => {
    const composition = hostileComposition(HOSTILE_NAMES)
    const csv = composeOverlayExportSelectSql(composition, 'csv')
    for (const name of HOSTILE_NAMES) {
      expect(csv, name).toContain(`${quotedIdentifier(name)}${guardedAlias(name)}`)
    }
  })

  it('leaves every non-CSV format byte-identical (names are data keys, never aliased)', () => {
    const composition = hostileComposition(HOSTILE_NAMES)
    for (const format of ['parquet', 'jsonl', 'json', 'arrow'] as const) {
      const sql = composeOverlayExportSelectSql(composition, format)
      expect(sql.startsWith('SELECT "=SUM(A2:A3)", "+x", "-x", "@x",'), format).toBe(true)
      expect(sql, format).not.toContain(guardedAlias('=SUM(A2:A3)'))
      expect(sql, format).not.toContain(guardedAlias('\n=x'))
    }
    // A benign-named CSV projection still aliases (the guard is a no-op there).
    const benign = hostileComposition(['id', 'label'])
    expect(
      composeOverlayExportSelectSql(benign, 'csv').startsWith(
        `SELECT "id" AS 'id', "label" AS 'label' FROM (`,
      ),
    ).toBe(true)
  })

  it('guards a header renamed in by an overlay op and covers base + insert branches', () => {
    // A live insert makes the source a base UNION ALL insert relation; the
    // header alias sits in the outer projection above the union, so it
    // applies to both branches positionally. The rename proves the effective
    // (post-overlay) name is the one guarded, not the base spelling.
    const composition = hostileComposition(
      ['plain'],
      [
        { kind: 'column-rename', from: 'plain', to: '=SUM(A2:A3)' },
        {
          kind: 'row-insert',
          rowId: rid('ins:o1#0'),
          position: { kind: 'start' },
          values: new Map(),
        },
      ],
    )
    const csv = composeOverlayExportSelectSql(composition, 'csv')
    expect(csv).toContain(`"=SUM(A2:A3)"${guardedAlias('=SUM(A2:A3)')}`)
    expect(csv).toContain('UNION ALL')
  })

  it('keeps value guarding at tab/LF/CR (the S1 LF addition) in the composed source', () => {
    const composition = hostileComposition(
      ['label'],
      [
        {
          kind: 'cell-set',
          rowId: rid('base:b1#0'),
          column: 'label',
          value: { kind: 'string', value: '\n=cmd' },
        },
      ],
    )
    const csv = composeOverlayExportSelectSql(composition, 'csv')
    // The value guard still wraps the expression (contains chr(10) now).
    expect(csv).toContain('contains(')
    expect(csv).toContain('chr(10)')
    // The header alias: benign name -> unchanged; only the value is guarded.
    expect(csv).toContain(`"label" AS 'label'`)
  })
})

describe('overlay composition — dead edits of tombstoned base rows (m4-4b round 4)', () => {
  // A deleted base row's edit is dead: the outer tombstone WHERE excludes the
  // row, so projecting the edit's CASE arm only gives DuckDB-WASM 1.4.3 a
  // value to evaluate (it evaluates the projection of a physically-present
  // deleted row even though native 1.5.5 filters first). The composer must
  // skip it in EVERY projection; the fold still retains it so a row-restore
  // brings the arm back (m4-1 semantics).
  const DEAD_BASE: OverlayBase = {
    baseAnchor: 'b1',
    overlayAnchor: 'o1',
    columns: [{ name: 'price', type: 'DOUBLE' }],
    baseRowCount: 3,
  }
  const compositionForOps = (ops: EditOp[]) => ({
    viewName: 'assay_t1',
    base: DEAD_BASE,
    state: foldOverlay(DEAD_BASE, ops).state,
  })
  const DEAD_OPS: EditOp[] = [
    {
      kind: 'cell-set',
      rowId: rid('base:b1#1'),
      column: 'price',
      value: { kind: 'string', value: 'oops' },
    },
    { kind: 'row-delete', rowId: rid('base:b1#1') },
  ]

  it('omits the dead edit literal/arm from window, count, schema, export and cast check', () => {
    const composition = compositionForOps(DEAD_OPS)
    const projections: readonly (readonly [string, string])[] = [
      ['window', composeOverlayWindowSql({ ...composition, limit: 5, offset: 0 })],
      ['count', composeOverlayCountSql(composition)],
      ['schema', composeOverlaySchemaSql(composition)],
      ['export', composeOverlayExportSelectSql(composition, 'parquet')],
      ['cast check', composeOverlayCastCheckSql(composition, 'price', 'INTEGER')],
    ]
    for (const [label, sql] of projections) {
      expect(sql, label).not.toContain('oops')
      expect(sql, label).not.toContain('CASE WHEN')
    }
    // The row itself is still excluded by the outer tombstone filter.
    expect(projections[0]![1]).toContain('WHERE assay_overlay_ord NOT IN (1)')
  })

  it('returns the dead arm when the row is restored (state retains the edit)', () => {
    const restored = compositionForOps([
      ...DEAD_OPS,
      { kind: 'row-restore', rowId: rid('base:b1#1') },
    ])
    const windowSql = composeOverlayWindowSql({ ...restored, limit: 5, offset: 0 })
    expect(windowSql).toContain(`CASE WHEN assay_overlay_ord = 1 THEN CAST('oops' AS DOUBLE)`)
    expect(windowSql).not.toContain('NOT IN (1)')
    const checkSql = composeOverlayCastCheckSql(restored, 'price', 'INTEGER')
    expect(checkSql).toContain(
      `assay_overlay_ord = 1 AND 'oops' IS NOT NULL AND TRY_CAST('oops' AS INTEGER) IS NULL`,
    )
  })

  it('omits a prior-cast dead edit arm and restores it (the reviewer flow shape)', () => {
    const ops: EditOp[] = [
      { kind: 'column-cast', column: 'price', targetType: 'VARCHAR' },
      {
        kind: 'cell-set',
        rowId: rid('base:b1#2'),
        column: 'price',
        value: { kind: 'string', value: 'oops' },
      },
      { kind: 'row-delete', rowId: rid('base:b1#2') },
    ]
    const composition = compositionForOps(ops)
    const windowSql = composeOverlayWindowSql({ ...composition, limit: 5, offset: 0 })
    expect(windowSql).not.toContain("CAST('oops' AS VARCHAR)")
    expect(windowSql).not.toContain('CASE WHEN')
    const checkSql = composeOverlayCastCheckSql(composition, 'price', 'INTEGER')
    expect(checkSql).not.toContain('oops')
    const restored = compositionForOps([...ops, { kind: 'row-restore', rowId: rid('base:b1#2') }])
    expect(composeOverlayWindowSql({ ...restored, limit: 5, offset: 0 })).toContain(
      "CASE WHEN assay_overlay_ord = 2 THEN CAST('oops' AS VARCHAR)",
    )
    expect(composeOverlayCastCheckSql(restored, 'price', 'INTEGER')).toContain(
      `assay_overlay_ord = 2 AND 'oops' IS NOT NULL AND TRY_CAST('oops' AS INTEGER) IS NULL`,
    )
  })
})

describe.skipIf(!hasDuckDbCli)(
  'composeOverlayCastCheckSql — behaviour against the pinned DuckDB CLI (R1-C)',
  () => {
    // The elision above is a *proof*, not an approximation: it may only drop an
    // arm that can never fire. These probes run the real composed statements
    // against the pinned CLI (v1.5.5, the agreement pattern of
    // `export-boundary.test.ts`/`row-diff-agreement.test.ts`) and show both
    // directions on one fixture: the elided shape still finds a bad edited
    // literal, and the retained shape still finds a bad base value.
    const CLI_BASE: OverlayBase = {
      baseAnchor: 'b1',
      overlayAnchor: 'o1',
      columns: [
        { name: 'label', type: 'VARCHAR' },
        { name: 'd', type: 'DATE' },
        { name: 'price', type: 'DOUBLE' },
      ],
      baseRowCount: 2,
    }
    const SETUP = [
      'CREATE TABLE assay_t1 (label VARCHAR, d DATE, price DOUBLE);',
      "INSERT INTO assay_t1 VALUES ('base', DATE '2020-01-01', 1.5), ('base2', DATE '2021-02-02', 2.5);",
    ]
    const compositionWith = (ops: EditOp[]) => ({
      viewName: 'assay_t1',
      base: CLI_BASE,
      state: foldOverlay(CLI_BASE, ops).state,
    })

    /** The check's answer as the engine sees it: `'1'` = a value cannot convert. */
    function probe(sql: string): string {
      const dir = mkdtempSync(join(tmpdir(), 'assay-r1c-cast-check-'))
      try {
        const script = join(dir, 'probe.sql')
        writeFileSync(script, `${[...SETUP, sql].join('\n')}\n`, 'utf8')
        const stdout = execFileSync(
          DUCKDB_CLI,
          ['-list', '-noheader', join(dir, 'probe.duckdb'), '-f', script],
          { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] },
        )
        return String(stdout).trim()
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }

    it('finds a bad edited literal with the base arm elided (the cell-edit shape)', () => {
      const sql = composeOverlayCastCheckSql(
        compositionWith([
          {
            kind: 'cell-set',
            rowId: rid('base:b1#0'),
            column: 'd',
            value: { kind: 'text', text: 'not-a-date' },
          },
        ]),
        'd',
        'DATE',
      )
      // The elided statement carries no base-column predicate at all ...
      expect(sql).not.toContain('TRY_CAST("d"')
      // ... and the edit literal it does carry is still caught by the engine.
      expect(probe(sql)).toBe('1')
    })

    it('answers false for a convertible edit in the same elided shape (non-vacuous)', () => {
      const sql = composeOverlayCastCheckSql(
        compositionWith([
          {
            kind: 'cell-set',
            rowId: rid('base:b1#0'),
            column: 'd',
            value: { kind: 'text', text: '2024-05-06' },
          },
        ]),
        'd',
        'DATE',
      )
      expect(sql).not.toContain('TRY_CAST("d"')
      expect(probe(sql)).toBe('')
    })

    it('finds a bad base value when a cast is pending (base arm retained)', () => {
      // The cast pre-check shape: no edits, target type ≠ base type, so the
      // un-edited scan is kept and 'base'/'base2' fail the DATE conversion.
      const sql = composeOverlayCastCheckSql(compositionWith([]), 'label', 'DATE')
      expect(sql).toContain('TRY_CAST("label" AS DATE) IS NULL')
      expect(probe(sql)).toBe('1')
    })

    it('finds a bad edited literal with the base arm retained (prior-cast shape)', () => {
      const sql = composeOverlayCastCheckSql(
        compositionWith([
          { kind: 'column-cast', column: 'price', targetType: 'VARCHAR' },
          {
            kind: 'cell-set',
            rowId: rid('base:b1#0'),
            column: 'price',
            value: { kind: 'string', value: 'hello' },
          },
        ]),
        'price',
        'INTEGER',
      )
      // Effective (VARCHAR) ≠ base (DOUBLE): the un-edited arm is retained ...
      expect(sql).toContain('TRY_CAST("price" AS INTEGER) IS NULL')
      // ... and the failing value is the edited literal.
      expect(probe(sql)).toBe('1')
    })
  },
)
