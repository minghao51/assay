// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * `column-repair` composer tests — the U5 slice's engine-side surface
 * (EW-04D §11; the D16/D17 composition probe record §5).
 *
 * What is pinned here, in order of authority:
 *
 * - **Composer byte pins** — the §1 emitted shape (exception arms, `m + x + 1`
 *   arms once, explicit-set trim), **stacked projection layers** for
 *   multi-repair prefixes (earliest innermost, never one-expression nesting —
 *   the emitted SQL must not duplicate the inner wrap), the wrapped `DESCRIBE`
 *   (D16a), and the split-form cast check scoped to repair-composed columns
 *   (D16b) with repair-free columns byte-identical (their pins live unchanged
 *   in `overlay-query.test.ts`).
 * - **D17 conformance** — the TypeScript compose-time literal rewrite
 *   (`trimWithCodePoints` + exact map, `string`/`text`/null kinds only) vs the
 *   SQL `CASE` over the same literal, compared by md5 against the pinned CLI:
 *   NULL, empty, quotes, astral, binary equality, the anti-`String.prototype.
 *   trim()` set (NBSP/VT/FF/NEL/EM SPACE/BOM), and exactly-once application.
 * - **U5 differential** — the load-bearing deliverable: seeded,
 *   domain-faithful histories replayed over the **real** domain fold and the
 *   **real** composer, executed against the pinned DuckDB CLI, compared
 *   cell-by-cell with an independent model of EW-04D §6.2 forward
 *   position-order composition (non-commuting multi-repair, intervening
 *   applied sets/inserts/reverts, delete/restore, logged no-ops that do not
 *   mask, applied reverts that do, the round-3 counterexample). This is the
 *   test that closes verdict condition (vii).
 * - **Caps/refusals** — the D15 exception-arm cap, the export-budget pre-apply
 *   refusal, the D17 non-text insert-value refusal, and the schema op's
 *   insert-branch budget (a pinned D16 behavioural change).
 * - **D16 conformance** — schema type preservation against the engine
 *   (DECIMAL/ENUM/BLOB/… not misdescribed; the repaired textual column
 *   reports its wrap type).
 *
 * CLI-executed sections follow the repo's pinned-CLI agreement pattern
 * (`overlay-query.test.ts` R1-C probes; skipped when the CLI is absent).
 */
import { foldOverlay, trimWithCodePoints } from '@assay/domain'
import type { CellValue, EditOp, OverlayBase, RowId } from '@assay/domain'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  composeOverlayCastCheckSql,
  composeOverlayCountSql,
  composeOverlayExportSql,
  composeOverlayExportSelectSql,
  composeOverlaySchemaSql,
  composeOverlayWindowSql,
  MAX_OVERLAY_LIVE_INSERT_BRANCHES,
  MAX_REPAIR_EXCEPTION_ARMS,
  MAX_REPAIR_EXPORT_CELL_WORK,
  OverlayLiveInsertLimitError,
  OverlayRepairExceptionLimitError,
  OverlayRepairExportBudgetError,
  OverlayRepairInsertValueError,
} from './overlay-query'
import * as engineBarrel from './index'

/** Test-side branded-id constructor for canonical literal ids. */
const rid = (text: string): RowId => text as RowId

/** The pinned DuckDB CLI for the behavioural probes (skipped when absent). */
const DUCKDB_CLI = process.env['DUCKDB'] ?? '/tmp/duckdb'
const hasDuckDbCli = existsSync(DUCKDB_CLI)

/** D1's recommended default trim set — the explicit code-point set under test. */
const TRIM = ' \t\n\r'

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

const REPAIR = (
  mapping: ReadonlyMap<string, string>,
  column = 'label',
  trim: string | undefined = TRIM,
): EditOp => ({
  kind: 'column-repair',
  column,
  ...(trim !== undefined ? { trim } : {}),
  mapping,
})

/** A synthetic m-pair mapping for the size/additivity pins. */
const pairMap = (
  count: number,
  keyPrefix: string,
  valueOf: (index: number) => string,
): Map<string, string> =>
  new Map<string, string>(
    Array.from({ length: count }, (_, i): [string, string] => [
      `${keyPrefix}${String(i)}`,
      valueOf(i),
    ]),
  )

const SET = (ordinal: number, value: string | null): EditOp => ({
  kind: 'cell-set',
  rowId: rid(`base:b1#${String(ordinal)}`),
  column: 'label',
  value: value === null ? { kind: 'null' } : { kind: 'string', value },
})

/** The wrap bytes for one trim∘map layer, as the composer emits them. */
const wrapOperand = (ref: string): string => `trim(${ref}, '${TRIM}')`

// ---------------------------------------------------------------------------
// Composer byte pins — the §1 wrap and the stacked layers
// ---------------------------------------------------------------------------

describe('repair wrap — emitted-SQL shape (EW-04D §4.2/§1)', () => {
  it('composes the wrap with m + 1 arms once over the cursor underlying value', () => {
    const sql = composeOverlayWindowSql({
      ...compositionFor([
        REPAIR(
          new Map([
            ['alpha', 'ALPHA'],
            ['gamma', 'GAMMA'],
          ]),
        ),
      ]),
      limit: 5,
      offset: 0,
    })
    // One stacked layer over the composed source; the ordinal machinery stays
    // inside and the outer projection never carries it.
    expect(sql).toBe(
      `SELECT "id", "label" FROM (SELECT "id", ` +
        `CASE ${wrapOperand('"label"')} WHEN 'alpha' THEN CAST('ALPHA' AS VARCHAR) ` +
        `WHEN 'gamma' THEN CAST('GAMMA' AS VARCHAR) ELSE ${wrapOperand('"label"')} END AS "label", ` +
        `"assay_overlay_ord" FROM (SELECT "id" AS "id", "label" AS "label", assay_overlay_ord ` +
        `FROM (SELECT "id", "label", (row_number() OVER () - 1) AS assay_overlay_ord FROM "assay_t1"))) ` +
        `LIMIT 5 OFFSET 0`,
    )
    // The §1 shape: the trim set is the explicit one, twice (operand + ELSE).
    expect(sql.match(/trim\(/g)).toHaveLength(2)
    expect(sql).not.toContain('assay_row_id')
    expect(sql).not.toContain('assay_key')
  })

  it('wraps the folded edit arms: the wrap reads the cursor underlying value', () => {
    const sql = composeOverlayWindowSql({
      ...compositionFor([SET(0, 'old'), REPAIR(new Map([['old', 'new']]))]),
      limit: 5,
      offset: 0,
    })
    // The base branch's edit arm (the cursor underlying value u) is the wrap
    // input; prior renames/casts would rewrite the alias/CAST it reads.
    expect(sql).toContain(
      `CASE WHEN assay_overlay_ord = 0 THEN CAST('old' AS VARCHAR) ELSE "label" END AS "label"`,
    )
    expect(sql).toContain(
      `CASE ${wrapOperand('"label"')} WHEN 'old' THEN CAST('new' AS VARCHAR) ELSE ${wrapOperand('"label"')} END`,
    )
  })

  it('carries per-row exception arms for masked rows and not-live-at-p rows, never tombstoned ones', () => {
    const ops: EditOp[] = [
      // deleted before the repair, restored after → exception (not live at p)
      { kind: 'row-delete', rowId: rid('base:b1#1') },
      REPAIR(new Map([['old', 'new']])),
      { kind: 'row-restore', rowId: rid('base:b1#1') },
      // applied suffix value-op on the repair column → exception (masker)
      SET(2, 'old'),
      // applied value-op BEFORE the repair → no exception (the wrap applies
      // to the edited value); its arm stays inside the wrap input
      SET(0, 'old'),
    ]
    // Order matters: place the pre-repair set before the repair op.
    const ordered: EditOp[] = [
      { kind: 'row-delete', rowId: rid('base:b1#1') },
      SET(0, 'old'),
      REPAIR(new Map([['old', 'new']])),
      { kind: 'row-restore', rowId: rid('base:b1#1') },
      SET(2, 'old'),
    ]
    const sql = composeOverlayWindowSql({ ...compositionFor(ordered), limit: 5, offset: 0 })
    // Exception arms are sorted ascending by ordinal.
    expect(sql).toContain('WHEN assay_overlay_ord = 2 THEN "label"')
    expect(sql).toContain('WHEN assay_overlay_ord = 1 THEN "label"')
    expect(sql).not.toContain('WHEN assay_overlay_ord = 0 THEN "label"')
    // The tombstone is gone (restored): no tombstone filter, and the restored
    // row's exception arm reads its underlying cursor value untransformed.
    expect(sql).not.toContain('NOT IN (1)')
    expect(sql.indexOf('WHEN assay_overlay_ord = 2')).toBeGreaterThan(-1)
    // The whole wrap is one outer CASE with the mapping CASE as its ELSE.
    expect(sql).toContain(
      `CASE WHEN assay_overlay_ord = 1 THEN "label" WHEN assay_overlay_ord = 2 THEN "label" ` +
        `ELSE CASE ${wrapOperand('"label"')} WHEN 'old' THEN CAST('new' AS VARCHAR) ` +
        `ELSE ${wrapOperand('"label"')} END END`,
    )
    void ops
  })

  it('composes multi-repair prefixes as stacked projection layers, earliest innermost', () => {
    const sql = composeOverlayWindowSql({
      ...compositionFor([
        REPAIR(new Map([['old', 'middle']])),
        REPAIR(new Map([['middle', 'final']])),
      ]),
      limit: 5,
      offset: 0,
    })
    // Two nested SELECT layers; the OUTER layer maps 'middle'→'final' and the
    // INNER maps 'old'→'middle' (forward position order — the round-3 rule).
    const outerStart = sql.indexOf(
      `CASE ${wrapOperand('"label"')} WHEN 'middle' THEN CAST('final' AS VARCHAR)`,
    )
    const innerStart = sql.indexOf(
      `CASE ${wrapOperand('"label"')} WHEN 'old' THEN CAST('middle' AS VARCHAR)`,
    )
    expect(outerStart).toBeGreaterThan(-1)
    expect(innerStart).toBeGreaterThan(-1)
    expect(outerStart).toBeLessThan(innerStart)
    expect(sql.match(/FROM \(/g)).toHaveLength(4) // source inner + 2 layers + window FROM
  })

  it('never duplicates the inner wrap: trim count is exactly 2 per layer, size additive', () => {
    const single = composeOverlayWindowSql({
      ...compositionFor([REPAIR(pairMap(250, 'k', (i) => `v${String(i)}`))]),
      limit: 5,
      offset: 0,
    })
    const stacked = composeOverlayWindowSql({
      ...compositionFor([
        REPAIR(pairMap(250, 'k', (i) => `v${String(i)}`)),
        REPAIR(pairMap(250, 'j', (i) => `w${String(i)}`)),
      ]),
      limit: 5,
      offset: 0,
    })
    // U4/probe §4.2: one-expression nesting would duplicate the inner wrap
    // into every outer arm (O(∏ mₖ) bytes — 2.4 MB at two repairs, OOM at
    // three). The stacked shape is O(Σₖ (mₖ + 1)): each layer states its own
    // operand and ELSE exactly once.
    expect(stacked.match(/trim\(/g)).toHaveLength(4) // 2 per layer
    expect(single.match(/trim\(/g)).toHaveLength(2)
    // Additive bytes: two layers ≈ the two single layers plus overhead,
    // nowhere near the multiplicative 2.4 MB shape.
    const oneLayer = composeOverlayWindowSql({
      ...compositionFor([REPAIR(pairMap(250, 'j', (i) => `w${String(i)}`))]),
      limit: 5,
      offset: 0,
    })
    expect(stacked.length).toBeLessThan(single.length + oneLayer.length + 1000)
  })

  it('keeps the count path over the raw composed relation (values never affect counts)', () => {
    const sql = composeOverlayCountSql(compositionFor([REPAIR(new Map([['a', 'b']]))]))
    expect(sql).not.toContain('trim(')
    expect(sql).toContain('count(*)::BIGINT')
  })

  it('applies post-repair casts outside the wrap (per-segment cast-chain collapse)', () => {
    const base: OverlayBase = {
      ...BASE,
      columns: [
        { name: 'id', type: 'BIGINT' },
        { name: 'label', type: 'VARCHAR' },
      ],
    }
    const ops: EditOp[] = [
      REPAIR(new Map([['a', 'b']]), 'label', TRIM),
      { kind: 'column-cast', column: 'label', targetType: 'BIGINT' },
    ]
    const state = foldOverlay(base, ops).state
    const sql = composeOverlayWindowSql({
      viewName: 'assay_t1',
      base,
      state,
      limit: 5,
      offset: 0,
    })
    // The wrap input stays textual (the type at the repair); the committed
    // BIGINT cast applies OUTSIDE the wrap — trimming an INTEGER is a Binder
    // Error (probe §7.1 constraint 2).
    expect(sql).toContain(
      `CAST(CASE ${wrapOperand('"label"')} WHEN 'a' THEN CAST('b' AS VARCHAR) ELSE ${wrapOperand('"label"')} END AS BIGINT)`,
    )
  })
})

describe('repair wrap — the wrapped DESCRIBE (D16a)', () => {
  it('describes the layered relation; the ordinal is created inside and never projected', () => {
    const sql = composeOverlaySchemaSql(compositionFor([REPAIR(new Map([['a', 'b']]))]))
    expect(sql).toBe(
      `DESCRIBE SELECT "id" AS "id", "label" AS "label" FROM (SELECT "id", ` +
        `CASE ${wrapOperand('"label"')} WHEN 'a' THEN CAST('b' AS VARCHAR) ELSE ${wrapOperand('"label"')} END AS "label", ` +
        `"assay_overlay_ord" FROM (SELECT "id" AS "id", "label" AS "label", assay_overlay_ord ` +
        `FROM (SELECT "id", "label", (row_number() OVER () - 1) AS assay_overlay_ord FROM "assay_t1")))`,
    )
    // The DESCRIBED relation's top-level projection carries no machinery.
    const head = sql.slice(0, sql.indexOf(' FROM ('))
    expect(head).not.toContain('assay_overlay_ord')
    expect(head).not.toContain('assay_row_id')
  })
})

// ---------------------------------------------------------------------------
// D17 — the compose-time literal rewrite (insert branches)
// ---------------------------------------------------------------------------

describe('repair literal rewrite (D17) — insert branches get 0 added arms', () => {
  it('rewrites a live insert literal once, replacing the wrap for that row', () => {
    const sql = composeOverlayWindowSql({
      ...compositionFor([
        {
          kind: 'row-insert',
          rowId: rid('ins:o1#0'),
          position: { kind: 'end' },
          values: new Map([['label', { kind: 'string', value: ' alpha ' }]]),
        },
        REPAIR(new Map([['alpha', 'ALPHA']])),
      ]),
      limit: 5,
      offset: 0,
    })
    // The branch literal is the rewritten value — never wrapped again.
    expect(sql).toContain(`CAST('ALPHA' AS VARCHAR) AS "label"`)
    expect(sql).not.toContain(`CAST(' alpha ' AS VARCHAR)`)
    // The insert pass-through arm exists (inserted rows bypass the layers).
    expect(sql).toContain('WHEN assay_overlay_ord IS NULL THEN "label"')
    // Zero added arms: exactly one mapping CASE (the base layer's), two trims.
    expect(sql.match(/trim\(/g)).toHaveLength(2)
    expect(sql.match(/WHEN 'alpha' THEN/g)).toHaveLength(1)
  })

  it('applies surviving repairs forward and exactly once across the stack', () => {
    // r2 survivor only (inserted before p2, after p1): 'b' → 'c', not 'b'→…→'c' cascaded.
    const survivorSecond = compositionFor([
      REPAIR(new Map([['a', 'b']])),
      {
        kind: 'row-insert',
        rowId: rid('ins:o1#0'),
        position: { kind: 'end' },
        values: new Map([['label', { kind: 'string', value: 'b' }]]),
      },
      REPAIR(new Map([['b', 'c']])),
    ])
    const sql2 = composeOverlayWindowSql({ ...survivorSecond, limit: 5, offset: 0 })
    expect(sql2).toContain(`CAST('c' AS VARCHAR) AS "label"`)
    // Both repairs survive (inserted first): a→b then b→c = 'c' — the probe's
    // exactly-once case: two layers, applied once each, never re-applied.
    const bothSurvive = compositionFor([
      {
        kind: 'row-insert',
        rowId: rid('ins:o1#0'),
        position: { kind: 'end' },
        values: new Map([['label', { kind: 'string', value: 'a' }]]),
      },
      REPAIR(new Map([['a', 'b']])),
      REPAIR(new Map([['b', 'c']])),
    ])
    const sqlBoth = composeOverlayWindowSql({ ...bothSurvive, limit: 5, offset: 0 })
    expect(sqlBoth).toContain(`CAST('c' AS VARCHAR) AS "label"`)
    expect(sqlBoth).not.toContain(`CAST('b' AS VARCHAR) AS "label"`)
    // One repair {a→b, b→c} applied ONCE to 'a' yields 'b' — double
    // application would cascade to 'c' (probe7's double-apply case).
    const once = compositionFor([
      {
        kind: 'row-insert',
        rowId: rid('ins:o1#0'),
        position: { kind: 'end' },
        values: new Map([['label', { kind: 'string', value: 'a' }]]),
      },
      REPAIR(
        new Map([
          ['a', 'b'],
          ['b', 'c'],
        ]),
      ),
    ])
    const sqlOnce = composeOverlayWindowSql({ ...once, limit: 5, offset: 0 })
    expect(sqlOnce).toContain(`CAST('b' AS VARCHAR) AS "label"`)
  })

  it('rewrites only string/text kinds; a non-text merged value on a surviving repair refuses', () => {
    const numberValue = compositionFor([
      {
        kind: 'row-insert',
        rowId: rid('ins:o1#0'),
        position: { kind: 'end' },
        values: new Map([['label', { kind: 'number', value: 1e-7 }]]),
      },
      REPAIR(new Map([['alpha', 'ALPHA']])),
    ])
    // The engine renders 1e-7::VARCHAR as '1e-07' while String() gives
    // '1e-7' (probe §2.4) — the rewrite cannot claim that value.
    for (const compose of [
      () => composeOverlayWindowSql({ ...numberValue, limit: 5, offset: 0 }),
      () => composeOverlaySchemaSql(numberValue),
      () => composeOverlayExportSelectSql(numberValue, 'jsonl'),
    ]) {
      expect(compose).toThrow(OverlayRepairInsertValueError)
    }
    // NULL values rewrite as NULL (r(null) = null), never to ''.
    const nullValue = compositionFor([
      {
        kind: 'row-insert',
        rowId: rid('ins:o1#0'),
        position: { kind: 'end' },
        values: new Map([]),
      },
      REPAIR(new Map([['alpha', 'ALPHA']])),
    ])
    const sql = composeOverlayWindowSql({ ...nullValue, limit: 5, offset: 0 })
    expect(sql).toContain('CAST(NULL AS VARCHAR) AS "label"')
    // A masked (suffix value-op) insert row keeps its raw literal.
    const masked = compositionFor([
      {
        kind: 'row-insert',
        rowId: rid('ins:o1#0'),
        position: { kind: 'end' },
        values: new Map([['label', { kind: 'string', value: 'alpha' }]]),
      },
      REPAIR(new Map([['alpha', 'ALPHA']])),
      {
        kind: 'cell-set',
        rowId: rid('ins:o1#0'),
        column: 'label',
        value: { kind: 'number', value: 9 },
      },
    ])
    const sqlMasked = composeOverlayWindowSql({ ...masked, limit: 5, offset: 0 })
    expect(sqlMasked).toContain('CAST(9 AS VARCHAR) AS "label"')
  })

  it('runs the surrogate guard on the rewritten output, not only the input', () => {
    // A VALID input whose mapping TARGET is an unpaired surrogate: the input
    // passes every entry guard, the rewrite produces the hostile text, and
    // the rewritten-output guard must refuse it with the repair-specific
    // value-free message. The specific message is what makes this guard's
    // execution observable (cellLiteralSql re-guards string kinds beneath it
    // with the generic message — defence in depth, pinned at both layers).
    const rewrite = compositionFor([
      {
        kind: 'row-insert',
        rowId: rid('ins:o1#0'),
        position: { kind: 'end' },
        values: new Map([['label', { kind: 'string', value: 'ok' }]]),
      },
      REPAIR(new Map([['ok', '\uD800']])),
    ])
    expect(() => composeOverlayWindowSql({ ...rewrite, limit: 5, offset: 0 })).toThrow(
      /repaired value contains an unpaired surrogate/,
    )
  })

  it('guards the wrap mapping target even when no row matches the key', () => {
    // The base-row wrap renders mapping targets as CASE-arm literals
    // regardless of data, through sqlStringLiteral — which does NOT guard
    // surrogates and has no second layer beneath it. This is the
    // mutation-killable guard: removing it composes silently (the corruption
    // would only surface as U+FFFD at execution).
    const hostileTarget = compositionFor([REPAIR(new Map([['ok', '\uDBFF']]))])
    expect(() => composeOverlayWindowSql({ ...hostileTarget, limit: 5, offset: 0 })).toThrow(
      /unpaired surrogate/,
    )
    expect(() => composeOverlaySchemaSql(hostileTarget)).toThrow(/unpaired surrogate/)
  })
})

// ---------------------------------------------------------------------------
// Caps and budget refusals (D15; export envelope; insert-value)
// ---------------------------------------------------------------------------

describe('repair caps and refusals — typed, value-free, before any engine call', () => {
  it('publishes the repair error surface on the package barrel (the web row consumes it)', () => {
    // W8 pin: settle the public error surface before any host consumes it.
    // The barrel must re-export exactly these classes/caps so a host can
    // catch them by identity rather than message matching.
    for (const name of [
      'OverlayRepairExceptionLimitError',
      'OverlayRepairExportBudgetError',
      'OverlayRepairInsertValueError',
      'MAX_REPAIR_EXCEPTION_ARMS',
      'MAX_REPAIR_EXPORT_CELL_WORK',
    ] as const) {
      expect(engineBarrel, name).toHaveProperty(name)
    }
    expect(engineBarrel.MAX_REPAIR_EXCEPTION_ARMS).toBe(500)
    expect(engineBarrel.MAX_REPAIR_EXPORT_CELL_WORK).toBe(1_000_000_000)
    expect(new engineBarrel.OverlayRepairExportBudgetError().name).toBe(
      'OverlayRepairExportBudgetError',
    )
    expect(new engineBarrel.OverlayRepairExceptionLimitError().name).toBe(
      'OverlayRepairExceptionLimitError',
    )
    expect(new engineBarrel.OverlayRepairInsertValueError().name).toBe(
      'OverlayRepairInsertValueError',
    )
  })
  it('refuses more than MAX_REPAIR_EXCEPTION_ARMS exception arms per repair (D15)', () => {
    expect(MAX_REPAIR_EXCEPTION_ARMS).toBe(500)
    const big: OverlayBase = {
      ...BASE,
      baseRowCount: MAX_REPAIR_EXCEPTION_ARMS + 1,
    }
    const deletes: EditOp[] = Array.from({ length: MAX_REPAIR_EXCEPTION_ARMS + 1 }, (_, i) => ({
      kind: 'row-delete',
      rowId: rid(`base:b1#${String(i)}`),
    }))
    const state = foldOverlay(big, deletes).state
    expect(() =>
      composeOverlayWindowSql({
        viewName: 'assay_t1',
        base: big,
        state: foldOverlay(big, [...deletes, REPAIR(new Map([['a', 'b']]))]).state,
        limit: 5,
        offset: 0,
      }),
    ).toThrow(OverlayRepairExceptionLimitError)
    expect(() =>
      composeOverlayWindowSql({
        viewName: 'assay_t1',
        base: big,
        state,
        limit: 5,
        offset: 0,
      }),
    ).not.toThrow()
    void state
  })

  it('refuses exports whose projected rows × pairs exceed the published envelope — pre-apply', () => {
    expect(MAX_REPAIR_EXPORT_CELL_WORK).toBe(1_000_000_000)
    const huge: OverlayBase = { ...BASE, baseRowCount: 2_000_001 }
    const over = {
      viewName: 'assay_t1',
      base: huge,
      state: foldOverlay(huge, [REPAIR(pairMap(500, 'k', () => 'v'))]).state,
    }
    // 2 000 001 × 500 = 1 000 000 500 > 1e9 → refuse before composing.
    expect(() => composeOverlayExportSql(over, 'csv', 'e1')).toThrow(OverlayRepairExportBudgetError)
    expect(() => composeOverlayExportSelectSql(over, 'arrow')).toThrow(
      OverlayRepairExportBudgetError,
    )
    // Exactly on the envelope is allowed (2 000 000 × 500 = 1e9, the
    // U4-measured ~4 s corner on the shipped eh bundle).
    const atEnvelope: OverlayBase = { ...BASE, baseRowCount: 2_000_000 }
    expect(() =>
      composeOverlayExportSql(
        {
          viewName: 'assay_t1',
          base: atEnvelope,
          state: foldOverlay(atEnvelope, [REPAIR(pairMap(500, 'k', () => 'v'))]).state,
        },
        'csv',
        'e2',
      ),
    ).not.toThrow()
    // Repair-free exports never pay the check.
    expect(() =>
      composeOverlayExportSql({ ...compositionFor([]), base: huge }, 'csv', 'e3'),
    ).not.toThrow()
  })

  it('counts projected rows, never tombstoned ones: the tombstone boundary sits on the envelope', () => {
    // 2 000 001 base rows with ONE tombstone project 2 000 000 rows:
    // 2 000 000 × 500 = 1e9 — exactly the envelope, allowed. Without the
    // tombstone the same session projects 2 000 001 rows and refuses.
    const huge: OverlayBase = { ...BASE, baseRowCount: 2_000_001 }
    const tombstoned = foldOverlay(huge, [
      { kind: 'row-delete', rowId: rid('base:b1#0') },
      REPAIR(pairMap(500, 'k', () => 'v')),
    ]).state
    expect(() =>
      composeOverlayExportSql({ viewName: 'assay_t1', base: huge, state: tombstoned }, 'csv', 'e4'),
    ).not.toThrow()
    // Live inserts project too: one live insert over the tombstoned base
    // pushes projected rows back to 2 000 001 → refuse.
    const withInsert = foldOverlay(huge, [
      { kind: 'row-delete', rowId: rid('base:b1#0') },
      {
        kind: 'row-insert',
        rowId: rid('ins:o1#0'),
        position: { kind: 'end' },
        values: new Map([['id', { kind: 'number', value: 1 }]]),
      },
      REPAIR(pairMap(500, 'k', () => 'v')),
    ]).state
    expect(() =>
      composeOverlayExportSql({ viewName: 'assay_t1', base: huge, state: withInsert }, 'csv', 'e5'),
    ).toThrow(OverlayRepairExportBudgetError)
  })

  it('makes the schema op pay the live-insert branch budget (the pinned D16 behavioural change)', () => {
    const inserts = (count: number): EditOp[] =>
      Array.from({ length: count }, (_, i) => ({
        kind: 'row-insert',
        rowId: rid(`ins:o1#${String(i)}`),
        position: { kind: 'end' },
        values: new Map([['id', { kind: 'number', value: i }]]),
      }))
    expect(() =>
      composeOverlaySchemaSql(compositionFor(inserts(MAX_OVERLAY_LIVE_INSERT_BRANCHES + 1))),
    ).toThrow(OverlayLiveInsertLimitError)
    expect(() =>
      composeOverlaySchemaSql(compositionFor(inserts(MAX_OVERLAY_LIVE_INSERT_BRANCHES))),
    ).not.toThrow()
  })

  it('sanitizes CSV above the wrap layers (the guard must see the post-repair value)', () => {
    const sql = composeOverlayExportSelectSql(
      compositionFor([REPAIR(new Map([['=cmd', 'safe']]))]),
      'csv',
    )
    const guardAt = sql.indexOf('CASE WHEN "label" IS NULL')
    const wrapAt = sql.indexOf('trim(')
    expect(guardAt).toBeGreaterThan(-1)
    expect(wrapAt).toBeGreaterThan(guardAt)
  })
})

// ---------------------------------------------------------------------------
// D16b — the split-form cast check, scoped to repair-composed columns
// ---------------------------------------------------------------------------

describe('repair cast check (D16b) — split form, scoped to repair columns', () => {
  it('composes the split form for a repair column: per-row trim+TRY_CAST+IN-membership, targets conditional', () => {
    const sql = composeOverlayCastCheckSql(
      compositionFor([
        REPAIR(
          new Map([
            ['alpha', 'ALPHA'],
            ['gamma', 'GAMMA'],
          ]),
        ),
      ]),
      'label',
      'BIGINT',
    )
    expect(sql).toBe(
      `SELECT 1 FROM (SELECT "label", assay_overlay_ord FROM ` +
        `(SELECT "id", "label", (row_number() OVER () - 1) AS assay_overlay_ord FROM "assay_t1")) ` +
        `WHERE ((${wrapOperand('"label"')} IS NOT NULL AND TRY_CAST(${wrapOperand('"label"')} AS BIGINT) IS NULL ` +
        `AND ${wrapOperand('"label"')} NOT IN ('alpha', 'gamma') ` +
        `OR ${wrapOperand('"label"')} IN (SELECT k FROM (VALUES ('alpha', 'ALPHA'), ('gamma', 'GAMMA')) AS p(k, t) ` +
        `WHERE TRY_CAST(t AS BIGINT) IS NULL))) LIMIT 1`,
    )
    // Predicate sites use set membership, never CASE chains — and there is
    // no unconditional per-target branch: a target is tested only inside the
    // engine-selected semi-join that a matching key reaches.
    expect(sql).not.toContain('CASE')
    expect(sql).not.toContain('UNION ALL SELECT 1 WHERE TRY_CAST(')
    // 1 per-row operand + 1 inside the engine-selected semi-join (the
    // semi-join's TRY_CAST is stated once for the pair relation, not per key).
    expect(sql.match(/TRY_CAST\(/g)).toHaveLength(2)
  })

  it('keeps edited non-exception rows on per-edit split arms and masked edited rows on raw arms', () => {
    const sql = composeOverlayCastCheckSql(
      compositionFor([
        SET(0, '5.5'), // applied before the repair: the wrap applies → split arm
        REPAIR(new Map([['alpha', 'ALPHA']])),
        SET(2, 'not-a-number'), // applied after the repair: masked → raw arm
      ]),
      'label',
      'BIGINT',
    )
    // The masked edit's surviving sub-chain is empty (its layer excepted):
    // the raw literal is tested directly — the pre-repair arm shape.
    expect(sql).toContain(
      `(assay_overlay_ord = 2 AND ('not-a-number' IS NOT NULL AND TRY_CAST('not-a-number' AS BIGINT) IS NULL))`,
    )
    // The un-masked edit keeps its per-row split arm (passthrough + the
    // mapped-target semi-join), and the full-chain conjunct skips both.
    expect(sql).toContain(
      `(assay_overlay_ord = 0 AND (${wrapOperand("'5.5'")} IS NOT NULL AND TRY_CAST(${wrapOperand("'5.5'")} AS BIGINT) IS NULL AND ${wrapOperand("'5.5'")} NOT IN ('alpha') ` +
        `OR ${wrapOperand("'5.5'")} IN (SELECT k FROM (VALUES ('alpha', 'ALPHA')) AS p(k, t) WHERE TRY_CAST(t AS BIGINT) IS NULL)))`,
    )
    expect(sql).toContain('assay_overlay_ord NOT IN (0, 2)')
    expect(sql).not.toContain('UNION ALL SELECT 1 WHERE TRY_CAST(')
  })

  it('omits the key test when m = 0 and the exception arms when x = 0', () => {
    const m0 = composeOverlayCastCheckSql(
      compositionFor([REPAIR(new Map(), 'label', TRIM)]),
      'label',
      'BIGINT',
    )
    expect(m0).not.toContain('NOT IN')
    expect(m0).toContain(`TRY_CAST(${wrapOperand('"label"')} AS BIGINT) IS NULL)`)
    const x0 = composeOverlayCastCheckSql(
      compositionFor([REPAIR(new Map([['alpha', 'ALPHA']]))]),
      'label',
      'BIGINT',
    )
    // x = 0 ⇒ no exception arms; the key-set membership tests stay (m = 1).
    expect(x0).not.toContain('assay_overlay_ord =')
    expect(x0).toContain(`AND ${wrapOperand('"label"')} NOT IN ('alpha')`)
    expect(x0).toContain(
      `OR ${wrapOperand('"label"')} IN (SELECT k FROM (VALUES ('alpha', 'ALPHA')) AS p(k, t) WHERE TRY_CAST(t AS BIGINT) IS NULL)`,
    )
  })

  it('emits the provably-empty check for a textual target (R1-C generalized, probe §3.4)', () => {
    const sql = composeOverlayCastCheckSql(
      compositionFor([
        REPAIR(
          new Map([
            ['alpha', 'ALPHA'],
            ['beta', 'BETA'],
          ]),
        ),
      ]),
      'label',
      'VARCHAR',
    )
    expect(sql).toBe('SELECT 1 WHERE FALSE LIMIT 1')
    // The wrap's declared type is text; TRY_CAST(text AS text) cannot fail and
    // every constant is a string — the whole statement is provably empty.
    expect(sql.match(/TRY_CAST\(/g) ?? []).toHaveLength(0)
  })

  it('leaves repair-free columns on the raw-arm shape (the only shape that sees the collapsed chain)', () => {
    const sql = composeOverlayCastCheckSql(compositionFor([]), 'label', 'BIGINT')
    expect(sql).toBe(
      'SELECT 1 FROM (SELECT "label", assay_overlay_ord FROM ' +
        '(SELECT "id", "label", (row_number() OVER () - 1) AS assay_overlay_ord FROM "assay_t1")) ' +
        'WHERE ("label" IS NOT NULL AND TRY_CAST("label" AS BIGINT) IS NULL) LIMIT 1',
    )
    expect(sql).not.toContain('trim(')
  })

  it('collapses a non-commuting multi-repair chain into one finite map (probe §3.5/probe18)', () => {
    const sql = composeOverlayCastCheckSql(
      compositionFor([
        REPAIR(
          new Map([
            ['alpha', 'ALPHA'],
            ['x', 'y'],
          ]),
        ),
        REPAIR(
          new Map([
            ['ALPHA', 'alpha2'],
            ['b', 'c'],
          ]),
        ),
      ]),
      'label',
      'BIGINT',
    )
    // Collapsed keys (chain-insertion order): alpha→alpha2 (via ALPHA),
    // x→y, b→c; 'ALPHA' is r1-passthrough that r2 maps — chain-evaluated as
    // ALPHA→alpha2. The failing subset is the engine's semi-join decision,
    // never an unconditional host-side branch.
    expect(sql).toContain(`NOT IN ('alpha', 'x', 'ALPHA', 'b')`)
    expect(sql).toContain(
      `IN (SELECT k FROM (VALUES ('alpha', 'alpha2'), ('x', 'y'), ('ALPHA', 'alpha2'), ('b', 'c')) AS p(k, t) WHERE TRY_CAST(t AS BIGINT) IS NULL)`,
    )
    expect(sql).not.toContain('UNION ALL SELECT 1 WHERE TRY_CAST(')
    // No CASE chains at predicate sites, and one per-row conjunct only.
    expect(sql).not.toContain('CASE')
    // The operand is stated four times in the row conjunct (IS NOT NULL,
    // TRY_CAST, NOT-IN-keys, IN-semi-join) — the probe's measured shape.
    expect(sql.match(/trim\(/g)).toHaveLength(4)
  })

  it('never fails a mapped target whose key no projected row holds (reviewer C1 repro)', () => {
    // Base '5'; the repair maps a key NOTHING matches to a value that cannot
    // convert. The committed window returns '5' (converts); the check must
    // answer false — the old unconditional per-target branch failed here.
    const ops: EditOp[] = [REPAIR(new Map([['absent', 'not-a-number']]))]
    const sql = composeOverlayCastCheckSql(compositionFor(ops), 'label', 'BIGINT')
    // The failing target lives ONLY inside the engine-selected semi-join.
    expect(sql).toContain(
      `IN (SELECT k FROM (VALUES ('absent', 'not-a-number')) AS p(k, t) WHERE TRY_CAST(t AS BIGINT) IS NULL)`,
    )
    expect(sql).not.toContain('UNION ALL SELECT 1 WHERE TRY_CAST(')
    if (!hasDuckDbCli) return
    // Real-engine agreement: the window materializes '5'; the check is empty.
    const setup = [
      'CREATE TABLE assay_t1 (id BIGINT, label VARCHAR);',
      "INSERT INTO assay_t1 VALUES (0, '5');",
    ]
    expect(runCli(setup, sql + ';')).toEqual([])
    const windowSql = composeOverlayWindowSql({ ...compositionFor(ops), limit: 5, offset: 0 })
    expect(runCli(setup, `SELECT label FROM (${windowSql});`)).toEqual(['5'])
  })

  it('keeps per-layer masking in the check: masked at one layer, repaired by the next (reviewer C2 repro)', () => {
    // r₁ x→2; an APPLIED set writes 'bad' (masks r₁ for row 0); r₂ bad→5.
    // The committed value for row 0 is r₂('bad') = '5' — convertible — so the
    // check must pass even though the RAW value 'bad' would fail. Unioning
    // exception layers (the old shape) tested raw 'bad' and falsely failed.
    const ops: EditOp[] = [
      SET(0, 'x'),
      REPAIR(new Map([['x', '2']])),
      SET(0, 'bad'),
      REPAIR(new Map([['bad', '5']])),
    ]
    const sql = composeOverlayCastCheckSql(compositionFor(ops), 'label', 'BIGINT')
    // Row 0's arm tests its SURVIVING sub-chain (r₂) over the raw literal:
    // the mapped semi-join carries ('bad', '5'), and '5' converts.
    expect(sql).toContain(
      `(assay_overlay_ord = 0 AND (${wrapOperand("'bad'")} IS NOT NULL AND TRY_CAST(${wrapOperand("'bad'")} AS BIGINT) IS NULL AND ${wrapOperand("'bad'")} NOT IN ('bad') ` +
        `OR ${wrapOperand("'bad'")} IN (SELECT k FROM (VALUES ('bad', '5')) AS p(k, t) WHERE TRY_CAST(t AS BIGINT) IS NULL)))`,
    )
    if (!hasDuckDbCli) return
    const setup = [
      'CREATE TABLE assay_t1 (id BIGINT, label VARCHAR);',
      "INSERT INTO assay_t1 VALUES (0, 'x'), (1, '2');",
    ]
    // Convertible chain output ('5'): check agrees with the committed window.
    expect(runCli(setup, sql + ';')).toEqual([])
    const windowSql = composeOverlayWindowSql({ ...compositionFor(ops), limit: 5, offset: 0 })
    expect(runCli(setup, `SELECT label FROM (${windowSql});`)).toEqual(['5', '2'])
    // A failing mapped target through the SAME surviving sub-chain fires —
    // the check still catches genuine committed-cast failures.
    const firing = composeOverlayCastCheckSql(
      compositionFor([
        SET(0, 'x'),
        REPAIR(new Map([['x', '2']])),
        SET(0, 'bad'),
        REPAIR(new Map([['bad', 'oops']])),
      ]),
      'label',
      'BIGINT',
    )
    expect(runCli(setup, firing + ';')).toEqual(['1'])
  })

  it('tests a pending cast over the repair output even when a post-repair cast changed the declared type', () => {
    const ops: EditOp[] = [
      REPAIR(new Map([['a', 'b']])),
      { kind: 'column-cast', column: 'label', targetType: 'BIGINT' },
    ]
    const state = foldOverlay(BASE, ops).state
    const sql = composeOverlayCastCheckSql(
      { viewName: 'assay_t1', base: BASE, state },
      'label',
      'VARCHAR',
    )
    // The per-segment collapse: the post-repair chain [BIGINT, VARCHAR]
    // collapses to one conversion of the wrap output; a textual target cannot
    // fail on it, so the check is provably empty.
    expect(sql).toBe('SELECT 1 WHERE FALSE LIMIT 1')
  })
})

// ---------------------------------------------------------------------------
// CLI-executed conformance — D17 table, U5 differential, D16 schema types
// ---------------------------------------------------------------------------

/** Run SQL against the pinned CLI and return non-empty `-list` lines. */
function runCli(setup: readonly string[], sql: string): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'assay-u5-repair-'))
  try {
    const script = join(dir, 'probe.sql')
    // The CLI normalizes CRLF to LF when reading a script file, which would
    // silently corrupt values that legitimately contain CR (a trim-set
    // member — the differential below seeds them). Every CR in composed SQL
    // sits inside a string literal (`sqlStringLiteral` only escapes single
    // quotes), so splicing `' || chr(13) || '` at each CR is byte-safe and
    // semantically identical; the composed bytes themselves are pinned
    // untransformed in the non-CLI sections above.
    const cliSql = sql.replaceAll('\r', "' || chr(13) || '")
    const cliSetup = setup.map((line) => line.replaceAll('\r', "' || chr(13) || '"))
    writeFileSync(script, `${[...cliSetup, cliSql].join('\n')}\n`, 'utf8')
    const stdout = execFileSync(
      DUCKDB_CLI,
      ['-list', '-noheader', join(dir, 'u5.duckdb'), '-f', script],
      { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    return String(stdout)
      .split('\n')
      .filter((line) => line.length > 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const md5 = (value: string): string => createHash('md5').update(value, 'utf8').digest('hex')

describe.skipIf(!hasDuckDbCli)('D17 conformance — TS rewrite ≡ SQL CASE (probe §2.3)', () => {
  // The mapping used by every case below (binary equality is pinned by 'OLD').
  const MAPPING = new Map<string, string>([
    ['alpha', 'ALPHA'],
    ['bs', 'back\\slash'],
  ])
  /** The D17 rewrite under test: the exact TypeScript half of the conformance claim. */
  const tsRewrite = (input: string | null): string | null => {
    if (input === null) return null
    const trimmed = trimWithCodePoints(input, TRIM)
    return MAPPING.get(trimmed) ?? trimmed
  }
  const sqlMappingCase = (literalSql: string): string =>
    `CASE trim(${literalSql}, '${TRIM}') WHEN 'alpha' THEN 'ALPHA' ` +
    `WHEN 'bs' THEN 'back\\slash' ELSE trim(${literalSql}, '${TRIM}') END`

  /** Each case: [name, the SQL literal spelling, the TS input (null = NULL cell)]. */
  const CASES: readonly (readonly [string, string, string | null])[] = [
    ['plain hit', `'alpha'`, 'alpha'],
    ['edge-trimmed hit', `' alpha '`, ' alpha '],
    ['miss unchanged', `'beta'`, 'beta'],
    ['passthrough is the trimmed value', `'  alpha  x '`, '  alpha  x '],
    ['CRLF edge pair', `'x\r\n'`, 'x\r\n'],
    ['all four set chars', `' \t\n\r'`, ' \t\n\r'],
    ['all-set → empty, never NULL', `'   '`, '   '],
    ['empty is data', `''`, ''],
    ['NBSP not trimmed', `'\u00A0x\u00A0'`, '\u00A0x\u00A0'],
    ['VT not trimmed', `'\u000Bx\u000C'`, '\u000Bx\u000C'],
    ['NEL + EM SPACE not trimmed', `'\u0085x\u2003'`, '\u0085x\u2003'],
    ['BOM not trimmed', `'\uFEFFx'`, '\uFEFFx'],
    ['binary equality: uppercase source misses', `'OLD'`, 'OLD'],
    ['quotes survive', `'quote''d'`, `quote'd`],
    ['astral passthrough', `'😀 alpha'`, '😀 alpha'],
    ['astral edge trimmed, interior kept', `' alpha 😀 '`, ' alpha 😀 '],
    ['non-ASCII BMP', `'héllo'`, 'héllo'],
    ['NULL never matches, never produced', `CAST(NULL AS VARCHAR)`, null],
    ['backslash key hit', `'bs'`, 'bs'],
  ]

  it('agrees with the SQL CASE on every hostile literal, compared by md5', () => {
    const rows: string[] = []
    for (const [name, literalSql] of CASES) {
      rows.push(
        `SELECT '${name.replaceAll("'", "''")}' AS case_name, ` +
          `${sqlMappingCase(literalSql)} IS NULL AS is_null, md5(${sqlMappingCase(literalSql)}) AS value_md5;`,
      )
    }
    const out = runCli([], rows.join('\n'))
    expect(out).toHaveLength(CASES.length)
    for (let i = 0; i < CASES.length; i++) {
      const tsInput = (CASES[i] as readonly [string, string, string | null])[2]
      const tsValue = tsRewrite(tsInput)
      const [caseName, cliIsNull, cliMd5] = (out[i] as string).split('|')
      const tsIsNull = tsValue === null
      expect([caseName, cliIsNull], `case ${String(i)}`).toEqual([
        (CASES[i] as readonly [string, string, string | null])[0],
        tsIsNull ? 'true' : 'false',
      ])
      if (!tsIsNull) {
        expect(cliMd5, `case ${caseName as string}`).toBe(md5(tsValue as string))
      }
    }
  })

  it('never applies the rewrite twice: the stacked SQL equals the once-applied TS chain', () => {
    // a→b→c reachable only across two stacked repairs: build the layered SQL
    // exactly as the composer stacks it and compare md5 with the once-applied
    // TS chain (probe7: applying ONE {a→b,b→c} wrap twice cascades to 'c').
    const trimLit = `'${TRIM}'`
    const inner = `CASE trim('a', ${trimLit}) WHEN 'a' THEN 'b' ELSE trim('a', ${trimLit}) END`
    const stacked = `CASE trim(${inner}, ${trimLit}) WHEN 'b' THEN 'c' ELSE trim(${inner}, ${trimLit}) END`
    const out = runCli([], `SELECT md5(${stacked});`)
    expect(out[0]).toBe(md5('c'))
    // The TS composed chain over 'a' through both repairs:
    let value = 'a'
    for (const mapping of [new Map([['a', 'b']]), new Map([['b', 'c']])]) {
      const trimmed = trimWithCodePoints(value, TRIM)
      value = mapping.get(trimmed) ?? trimmed
    }
    expect(value).toBe('c')
    // And one {a→b, b→c} wrap applied ONCE gives 'b' — the composer replaces
    // the wrap, never accompanies it (pinned above via the insert rewrite).
  })
})

// ---------------------------------------------------------------------------
// U5 — the differential: real fold + real composer vs the §6.2 model (P8)
// ---------------------------------------------------------------------------

/** mulberry32 — deterministic across platforms (repo convention: no Math.random). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79a5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Rng {
  int(min: number, max: number): number
  pick<T>(items: readonly T[]): T
  bool(p?: number): boolean
}

function makeRng(seed: number): Rng {
  const next = mulberry32(seed)
  return {
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: (items) => items[Math.floor(next() * items.length)] as (typeof items)[number],
    bool: (p = 0.5) => next() < p,
  }
}

/** The non-commuting P8 mapping pool plus edge-whitespace/dead-key-free keys. */
const MAPPING_POOL: ReadonlyArray<readonly (readonly [string, string])[]> = [
  [['old', 'middle']],
  [['middle', 'final']],
  [['old', 'new']],
  [['a', 'b']],
  [
    ['old', 'middle'],
    ['a', 'b'],
  ],
  [
    ['middle', 'final'],
    ['x', 'y'],
  ],
]
/** Base cell values the generator draws from (NULL and '' are data). */
const VALUE_POOL: ReadonlyArray<string | null> = [
  'old',
  'middle',
  'a',
  'x',
  'b',
  ' alpha ',
  'x\r\n',
  '',
  null,
  'beta',
]

const DIFF_BASE: OverlayBase = {
  baseAnchor: 'b1',
  overlayAnchor: 'o1',
  columns: [
    { name: 'id', type: 'BIGINT' },
    { name: 'label', type: 'VARCHAR' },
  ],
  baseRowCount: 6,
}

const DIFF_SETUP = [
  'CREATE TABLE assay_t1 (id BIGINT, label VARCHAR);',
  `INSERT INTO assay_t1 VALUES ` +
    Array.from(
      { length: DIFF_BASE.baseRowCount },
      (_, i) => `(${String(i)}, ${i % 2 === 1 ? 'NULL' : `'row${String(i)}'`})`,
    ).join(', ') +
    ';',
]

interface DiffRow {
  readonly key: string
  readonly baseLabel: string | null
  readonly isInsert: boolean
  readonly seq: number
  live: boolean
  edit: { value: string | null; exists: boolean }
  /** Positions of applied value-ops on (row, label) — for masking. */
  readonly appliedValueOps: number[]
  /** Repair positions whose liveness snapshot included this row. */
  readonly liveAtRepair: number[]
}

/**
 * The independent §6.2 model: replay the log materialized (values in TS),
 * driven by the REAL fold's outcomes (premise: only applied ops change
 * values; logged no-ops never mask). Returns the expected label per live row.
 */
function modelExpectedLabels(ops: readonly EditOp[]): Map<string, string | null> {
  const rows = new Map<string, DiffRow>()
  for (let i = 0; i < DIFF_BASE.baseRowCount; i++) {
    rows.set(`base:b1#${String(i)}`, {
      key: `base:b1#${String(i)}`,
      baseLabel: i % 2 === 1 ? null : `row${String(i)}`,
      isInsert: false,
      seq: -1,
      live: true,
      edit: { value: null, exists: false },
      appliedValueOps: [],
      liveAtRepair: [],
    })
  }
  const { applications } = foldOverlay(DIFF_BASE, ops)
  let nextSeq = 0
  ops.forEach((op, position) => {
    const outcome = (applications[position] as { outcome: { status: string } }).outcome.status
    switch (op.kind) {
      case 'cell-set':
      case 'cell-revert': {
        const target = rows.get(op.rowId)
        if (target === undefined || outcome !== 'applied') return
        target.appliedValueOps.push(position)
        if (op.kind === 'cell-set') {
          const value = op.value.kind === 'null' ? null : (op.value as { value: string }).value
          target.edit = { value, exists: true }
        } else {
          target.edit = { value: null, exists: false }
        }
        return
      }
      case 'row-insert': {
        if (outcome !== 'applied') return
        rows.set(op.rowId, {
          key: op.rowId,
          baseLabel: op.values.has('label')
            ? (op.values.get('label') as { kind: string; value?: string; text?: string }).kind ===
              'null'
              ? null
              : ((op.values.get('label') as { value?: string }).value ?? null)
            : null,
          isInsert: true,
          seq: nextSeq++,
          live: true,
          edit: { value: null, exists: false },
          appliedValueOps: [],
          liveAtRepair: [],
        })
        return
      }
      case 'row-delete': {
        const target = rows.get(op.rowId)
        if (target !== undefined && outcome === 'applied') target.live = false
        return
      }
      case 'row-restore': {
        const target = rows.get(op.rowId)
        if (target !== undefined && outcome === 'applied') target.live = true
        return
      }
      case 'row-uninsert': {
        if (outcome === 'applied') rows.delete(op.rowId)
        return
      }
      case 'column-repair': {
        if (outcome !== 'applied') return
        // Liveness snapshot at p: which rows were live just before this op.
        for (const row of rows.values()) if (row.live) row.liveAtRepair.push(position)
        return
      }
      default:
        return // renames/casts: not generated in the single-column corpus
    }
  })

  const expected = new Map<string, string | null>()
  for (const row of rows.values()) {
    if (!row.live) continue
    // The cursor underlying value u.
    let value = row.edit.exists ? row.edit.value : row.baseLabel
    // Forward position-order composition: repair k applies iff the row was
    // live at p_k AND no applied value-op on the row sits after p_k.
    ops.forEach((op, position) => {
      if (op.kind !== 'column-repair') return
      const liveAtP = row.liveAtRepair.includes(position)
      const masked = row.appliedValueOps.some((appliedAt) => appliedAt > position)
      if (!liveAtP || masked) return
      const mapping = (op as { mapping: ReadonlyMap<string, string> }).mapping
      const trim = (op as { trim?: string }).trim
      if (value !== null) {
        const trimmed = trim !== undefined ? trimWithCodePoints(value, trim) : value
        value = mapping.get(trimmed) ?? trimmed
      }
    })
    expected.set(row.key, value)
  }
  return expected
}

/** Seeded, liveness-mirroring generator over the single-column corpus (P8 discipline). */
function genDiffOps(rng: Rng, length: number): EditOp[] {
  const ops: EditOp[] = []
  const liveBase = new Set<number>(Array.from({ length: DIFF_BASE.baseRowCount }, (_, i) => i))
  const liveInserts = new Set<number>()
  const deadInserts = new Set<number>()
  const edits = new Map<string, string | null>()
  let seq = 0
  for (let i = 0; i < length; i++) {
    const roll = rng.int(0, 9)
    if (roll <= 2) {
      // cell-set on a live row (sometimes repeating the current edit → no-op)
      const useInsert = liveInserts.size > 0 && rng.bool()
      const key = useInsert
        ? `ins:o1#${String(rng.pick([...liveInserts]))}`
        : `base:b1#${String(rng.pick([...liveBase]))}`
      const current = edits.get(key)
      const value = current !== undefined && rng.bool(0.25) ? current : rng.pick(VALUE_POOL)
      edits.set(key, value)
      ops.push({
        kind: 'cell-set',
        rowId: rid(key),
        column: 'label',
        value: value === null ? { kind: 'null' } : { kind: 'string', value },
      })
    } else if (roll === 3) {
      // cell-revert on a row that has an edit (occasionally without → no-op)
      const edited = [...edits.keys()]
      const key =
        edited.length > 0 && rng.bool(0.85)
          ? (rng.pick(edited) as string)
          : `base:b1#${String(rng.pick([...liveBase]))}`
      edits.delete(key)
      ops.push({ kind: 'cell-revert', rowId: rid(key), column: 'label' })
    } else if (roll === 4) {
      // row-insert with the next seq
      const values = new Map<string, CellValue>([['id', { kind: 'number', value: 100 + seq }]])
      if (rng.bool(0.8)) {
        const value = rng.pick(VALUE_POOL)
        values.set('label', value === null ? { kind: 'null' } : { kind: 'string', value })
        edits.set(`ins:o1#${String(seq)}`, value)
      }
      ops.push({
        kind: 'row-insert',
        rowId: rid(`ins:o1#${String(seq)}`),
        position: rng.bool(0.5) ? { kind: 'end' } : { kind: 'start' },
        values,
      })
      liveInserts.add(seq)
      seq += 1
    } else if (roll === 5) {
      // row-delete on a live row
      const useInsert = liveInserts.size > 0 && rng.bool(0.4)
      if (useInsert) {
        const target = rng.pick([...liveInserts])
        liveInserts.delete(target)
        deadInserts.add(target)
        ops.push({ kind: 'row-delete', rowId: rid(`ins:o1#${String(target)}`) })
      } else if (liveBase.size > 0) {
        const target = rng.pick([...liveBase])
        liveBase.delete(target)
        ops.push({ kind: 'row-delete', rowId: rid(`base:b1#${String(target)}`) })
      }
    } else if (roll === 6) {
      // row-restore on a dead row
      const deadBase: number[] = []
      for (let o = 0; o < DIFF_BASE.baseRowCount; o++) if (!liveBase.has(o)) deadBase.push(o)
      if (deadInserts.size > 0 && rng.bool(0.4)) {
        const target = rng.pick([...deadInserts])
        deadInserts.delete(target)
        liveInserts.add(target)
        ops.push({ kind: 'row-restore', rowId: rid(`ins:o1#${String(target)}`) })
      } else if (deadBase.length > 0) {
        const target = rng.pick(deadBase)
        liveBase.add(target)
        ops.push({ kind: 'row-restore', rowId: rid(`base:b1#${String(target)}`) })
      }
    } else if (roll <= 8) {
      // column-repair (sometimes repeating a mapping → no-op-adjacent replay)
      const pairs = rng.pick(MAPPING_POOL)
      ops.push({
        kind: 'column-repair',
        column: 'label',
        ...(rng.bool(0.7) ? { trim: TRIM } : {}),
        mapping: new Map(pairs),
      })
    } else {
      // a value-op on a DEAD row: the real fold conflicts it, the model
      // ignores it — the corpus stays honest because outcomes drive both.
      ops.push({
        kind: 'cell-revert',
        rowId: rid(`base:b1#${String(rng.int(0, DIFF_BASE.baseRowCount - 1))}`),
        column: 'label',
      })
    }
  }
  return ops
}

describe.skipIf(!hasDuckDbCli)('U5 differential — real fold + composer vs the §6.2 model', () => {
  /** Execute the composed window (with row ids) and return rowId → md5-or-NULL rows. */
  function executeWindow(ops: readonly EditOp[]): Map<string, string> {
    const limit = DIFF_BASE.baseRowCount + ops.length + 5
    const windowSql = composeOverlayWindowSql({
      viewName: 'assay_t1',
      base: DIFF_BASE,
      state: foldOverlay(DIFF_BASE, ops).state,
      includeRowIds: true,
      limit,
      offset: 0,
    })
    const sql =
      `SELECT assay_row_id, md5(label) IS NULL AS null_label, ` +
      `COALESCE(md5(label), '-') AS label_md5 FROM (${windowSql});`
    const out = runCli(DIFF_SETUP, sql)
    const result = new Map<string, string>()
    for (const line of out) {
      const [rowId, nullFlag, labelMd5] = line.split('|')
      if (rowId === undefined) continue
      result.set(rowId, nullFlag === 'true' ? 'NULL' : (labelMd5 as string))
    }
    return result
  }

  function expectDifferential(ops: readonly EditOp[], label: string): void {
    const expected = modelExpectedLabels(ops)
    const actual = executeWindow(ops)
    expect([...actual.keys()].sort(), `${label}: projected rows`).toEqual(
      [...expected.keys()].sort(),
    )
    for (const [rowId, value] of expected) {
      const actualValue = actual.get(rowId) as string
      const expectedEncoding = value === null ? 'NULL' : md5(value)
      expect(actualValue, `${label}: row ${rowId}`).toBe(expectedEncoding)
    }
  }

  it('the round-3 counterexample: forward composition of non-commuting repairs', () => {
    expectDifferential(
      [SET(0, 'old'), REPAIR(new Map([['old', 'middle']])), REPAIR(new Map([['middle', 'final']]))],
      'counterexample',
    )
  })

  it('an applied set between repairs masks the earlier repair only', () => {
    expectDifferential(
      [
        SET(0, 'old'),
        REPAIR(new Map([['old', 'middle']])),
        SET(0, 'old'), // applied AFTER r1 → masks r1; r2 still applies
        REPAIR(new Map([['old', 'final']])),
      ],
      'intervening-applied-set',
    )
  })

  it('a logged NO-OP set between repairs never masks (round-4 correction)', () => {
    expectDifferential(
      [
        SET(0, 'old'),
        REPAIR(new Map([['old', 'middle']])),
        SET(0, 'old'), // identical to the edit already present → no-op
        REPAIR(new Map([['middle', 'final']])),
      ],
      'noop-set-between-repairs',
    )
  })

  it('a logged NO-OP revert between repairs never masks; an APPLIED revert does', () => {
    expectDifferential(
      [
        REPAIR(new Map([['old', 'middle']])),
        { kind: 'cell-revert', rowId: rid('base:b1#0'), column: 'label' }, // no edit → no-op
        REPAIR(new Map([['middle', 'final']])),
      ],
      'noop-revert-between-repairs',
    )
    expectDifferential(
      [
        SET(0, 'x'),
        REPAIR(new Map([['x', 'middle']])),
        { kind: 'cell-revert', rowId: rid('base:b1#0'), column: 'label' }, // applied → masks r1
        REPAIR(new Map([['row0', 'from-base']])),
      ],
      'applied-revert-masks',
    )
  })

  it('delete/restore: a restored row shows its pre-repair effective value (P3)', () => {
    expectDifferential(
      [
        SET(1, 'edited'), // edit before deletion, survives under the tombstone
        { kind: 'row-delete', rowId: rid('base:b1#1') },
        REPAIR(
          new Map([
            ['edited', 'REPAIRED'],
            ['row1', 'ROW1'],
          ]),
        ),
        { kind: 'row-restore', rowId: rid('base:b1#1') },
      ],
      'delete-restore',
    )
  })

  it('a later absolute write wins even when it writes a mapping-source value (P2)', () => {
    expectDifferential(
      [
        REPAIR(new Map([['old', 'new']])),
        SET(0, 'old'), // writes the SOURCE value after the repair
      ],
      'later-write-wins',
    )
  })

  it('inserts between and after repairs: the D17 rewrite meets the layered wrap', () => {
    expectDifferential(
      [
        {
          kind: 'row-insert',
          rowId: rid('ins:o1#0'),
          position: { kind: 'end' },
          values: new Map([['label', { kind: 'string', value: 'old' }]]),
        },
        REPAIR(new Map([['old', 'middle']])),
        {
          kind: 'row-insert',
          rowId: rid('ins:o1#1'),
          position: { kind: 'end' },
          values: new Map([['label', { kind: 'string', value: 'old' }]]),
        },
        REPAIR(new Map([['middle', 'final']])),
      ],
      'inserts-between-repairs',
    )
  })

  /**
   * Compose AND execute the pending-cast check next to the committed-window
   * failure probe in ONE CLI call, and assert the two agree: the check fires
   * exactly when some committed window value fails `TRY_CAST(label AS
   * BIGINT)`. The window's cell values themselves are compared against the
   * §6.2 model by {@link executeWindow} in the same loop iteration.
   */
  function executeWindowAndCheck(ops: readonly EditOp[]): void {
    const composition = {
      viewName: 'assay_t1' as const,
      base: DIFF_BASE,
      state: foldOverlay(DIFF_BASE, ops).state,
    }
    const windowSql = composeOverlayWindowSql({
      ...composition,
      includeRowIds: true,
      limit: DIFF_BASE.baseRowCount + ops.length + 5,
      offset: 0,
    })
    const committedFailure =
      `SELECT 'w' AS src, 1 AS hit FROM (${windowSql}) ` +
      `WHERE label IS NOT NULL AND TRY_CAST(label AS BIGINT) IS NULL LIMIT 1;`
    const checkSql = composeOverlayCastCheckSql(composition, 'label', 'BIGINT')
    const checkFires = `SELECT 'c' AS src, 1 AS hit FROM (${checkSql}) LIMIT 1;`
    const out = runCli(DIFF_SETUP, [committedFailure, checkFires].join('\n'))
    const committed = out.some((line) => line === 'w|1')
    const fired = out.some((line) => line === 'c|1')
    expect(fired, 'check vs committed window').toBe(committed)
  }

  it('seeded randomized histories over the real fold and composer: 0 mismatches', () => {
    let cellChecks = 0
    let multiRepairCases = 0
    let histories = 0
    let checkAgreements = 0
    for (const seed of [20261115, 7, 199, 404, 271828, 88, 31337, 5150]) {
      const rng = makeRng(seed)
      for (let session = 0; session < 40; session++) {
        histories += 1
        const ops = genDiffOps(rng, rng.int(4, 14))
        const repairCount = ops.filter((op) => op.kind === 'column-repair').length
        if (repairCount >= 2) multiRepairCases += 1
        const expected = modelExpectedLabels(ops)
        const actual = executeWindow(ops)
        expect(
          [...actual.keys()].sort(),
          `seed ${String(seed)} session ${String(session)}: projected rows`,
        ).toEqual([...expected.keys()].sort())
        for (const [rowId, value] of expected) {
          const actualValue = actual.get(rowId) as string
          expect(actualValue, `seed ${String(seed)} session ${String(session)} row ${rowId}`).toBe(
            value === null ? 'NULL' : md5(value),
          )
          cellChecks += 1
        }
        // The pending-cast check must agree with the committed window on
        // every history (fires iff some committed value fails TRY_CAST).
        executeWindowAndCheck(ops)
        checkAgreements += 1
      }
    }
    // The corpus must actually exercise the rule (guard against a vacuous pass).
    expect(histories).toBe(320)
    expect(cellChecks).toBeGreaterThan(1500)
    expect(multiRepairCases).toBeGreaterThan(60)
    expect(checkAgreements).toBe(320)
  }, 45_000)

  it('check-agreement corpus fires in both directions (non-vacuous)', () => {
    // A numeric-corpus fixture where BOTH directions are reachable: every
    // committed value converts (all-silent) only when the repair maps the
    // non-numeric seeds away; any surviving non-numeric value fires both.
    const numericBase: OverlayBase = {
      baseAnchor: 'b1',
      overlayAnchor: 'o1',
      columns: [
        { name: 'id', type: 'BIGINT' },
        { name: 'label', type: 'VARCHAR' },
      ],
      baseRowCount: 4,
    }
    const numericSetup = [
      'CREATE TABLE assay_t1 (id BIGINT, label VARCHAR);',
      "INSERT INTO assay_t1 VALUES (0, '5'), (1, 'x'), (2, '7'), (3, 'y');",
    ]
    const pool: ReadonlyArray<readonly (readonly [string, string])[]> = [
      [['x', '9']],
      [['x', 'oops']],
      [
        ['x', '9'],
        ['y', '11'],
      ],
      [
        ['x', '9'],
        ['y', 'nope'],
      ],
    ]
    let fired = 0
    let silent = 0
    for (const seed of [20261115, 7]) {
      const rng = makeRng(seed)
      for (let session = 0; session < 20; session++) {
        const ops: EditOp[] = []
        const live = [0, 1, 2, 3]
        const dead: number[] = []
        for (let step = 0, n = rng.int(2, 8); step < n; step++) {
          const roll = rng.int(0, 4)
          if (roll <= 1) {
            const ordinal = rng.pick(live)
            const value = rng.pick(['5', 'x', '7', 'y', '9', '11'])
            ops.push({
              kind: 'cell-set',
              rowId: rid(`base:b1#${String(ordinal)}`),
              column: 'label',
              value: { kind: 'string', value },
            })
          } else if (roll === 2) {
            ops.push({
              kind: 'cell-revert',
              rowId: rid(`base:b1#${String(rng.pick(live))}`),
              column: 'label',
            })
          } else if (roll === 3 && live.length > 1) {
            const ordinal = rng.pick(live)
            dead.push(ordinal)
            live.splice(live.indexOf(ordinal), 1)
            ops.push({ kind: 'row-delete', rowId: rid(`base:b1#${String(ordinal)}`) })
          } else if (dead.length > 0) {
            const ordinal = rng.pick(dead)
            dead.splice(dead.indexOf(ordinal), 1)
            live.push(ordinal)
            ops.push({ kind: 'row-restore', rowId: rid(`base:b1#${String(ordinal)}`) })
          }
        }
        ops.push({
          kind: 'column-repair',
          column: 'label',
          ...(rng.bool(0.7) ? { trim: TRIM } : {}),
          mapping: new Map(rng.pick(pool)),
        })
        const composition = {
          viewName: 'assay_t1' as const,
          base: numericBase,
          state: foldOverlay(numericBase, ops).state,
        }
        const windowSql = composeOverlayWindowSql({
          ...composition,
          limit: numericBase.baseRowCount + 5,
          offset: 0,
        })
        const committedFailure =
          `SELECT 'w' AS src, 1 AS hit FROM (${windowSql}) ` +
          `WHERE label IS NOT NULL AND TRY_CAST(label AS BIGINT) IS NULL LIMIT 1;`
        const checkSql = composeOverlayCastCheckSql(composition, 'label', 'BIGINT')
        const checkFires = `SELECT 'c' AS src, 1 AS hit FROM (${checkSql}) LIMIT 1;`
        const out = runCli(numericSetup, [committedFailure, checkFires].join('\n'))
        expect(out.some((line) => line === 'c|1')).toBe(out.some((line) => line === 'w|1'))
        if (out.some((line) => line === 'c|1')) fired += 1
        else silent += 1
      }
    }
    // Both directions must occur — an always-firing or always-silent
    // agreement would be vacuous.
    expect(fired).toBeGreaterThan(0)
    expect(silent).toBeGreaterThan(0)
  }, 30_000)
  // The 45 s budget above is per-test, never a weakened assertion: one CLI
  // spawn per history (the repo's pinned-CLI agreement pattern) costs ~16 s
  // wall for 320 histories once each spawn also carries the check-agreement
  // statement, against the node project's 5000 ms default — the same
  // harness-ceiling class gd-1 documented for the CLI integration suite.
})

// ---------------------------------------------------------------------------
// D16 conformance — schema type preservation against the engine
// ---------------------------------------------------------------------------

describe.skipIf(!hasDuckDbCli)('D16 conformance — schema types against the pinned CLI', () => {
  const TYPED_SETUP = [
    `CREATE TABLE assay_t1 (
      id BIGINT,
      label VARCHAR,
      amount DECIMAL(10,2),
      ratio DOUBLE,
      tags INTEGER[],
      rec STRUCT(a INTEGER),
      blob BLOB,
      day DATE,
      flag BOOLEAN,
      status ENUM('a','b')
    );`,
    `INSERT INTO assay_t1 VALUES (1, 'x', 1.5, 2.5, [1], {'a': 1}, '\u0001\x02', DATE '2020-01-01', true, 'a');`,
  ]

  function describedTypes(ops: readonly EditOp[]): Map<string, string> {
    const schemaSql = composeOverlaySchemaSql({
      viewName: 'assay_t1',
      base: {
        baseAnchor: 'b1',
        overlayAnchor: 'o1',
        columns: [
          { name: 'id', type: 'BIGINT' },
          { name: 'label', type: 'VARCHAR' },
          { name: 'amount', type: 'DECIMAL(10,2)' },
          { name: 'ratio', type: 'DOUBLE' },
          { name: 'tags', type: 'INTEGER[]' },
          { name: 'rec', type: 'STRUCT(a INTEGER)' },
          { name: 'blob', type: 'BLOB' },
          { name: 'day', type: 'DATE' },
          { name: 'flag', type: 'BOOLEAN' },
          { name: 'status', type: "ENUM('a','b')" },
        ],
        baseRowCount: 1,
      },
      state: foldOverlay(
        {
          baseAnchor: 'b1',
          overlayAnchor: 'o1',
          columns: [
            { name: 'id', type: 'BIGINT' },
            { name: 'label', type: 'VARCHAR' },
            { name: 'amount', type: 'DECIMAL(10,2)' },
            { name: 'ratio', type: 'DOUBLE' },
            { name: 'tags', type: 'INTEGER[]' },
            { name: 'rec', type: 'STRUCT(a INTEGER)' },
            { name: 'blob', type: 'BLOB' },
            { name: 'day', type: 'DATE' },
            { name: 'flag', type: 'BOOLEAN' },
            { name: 'status', type: "ENUM('a','b')" },
          ],
          baseRowCount: 1,
        },
        ops,
      ).state,
    })
    const out = runCli(TYPED_SETUP, schemaSql + ';')
    const types = new Map<string, string>()
    for (const line of out) {
      const fields = line.split('|')
      if (fields[0] !== undefined && fields[1] !== undefined) types.set(fields[0], fields[1])
    }
    return types
  }

  it('preserves DECIMAL/ENUM/BLOB/array/struct types on repair-free columns; the repaired column reports its wrap type', () => {
    const types = describedTypes([
      REPAIR(new Map([['x', 'y']])),
      {
        kind: 'row-insert',
        rowId: rid('ins:o1#0'),
        position: { kind: 'end' },
        values: new Map([['label', { kind: 'string', value: 'ins' }]]),
      },
      {
        kind: 'cell-set',
        rowId: rid('base:b1#0'),
        column: 'amount',
        value: { kind: 'text', text: '9.99' },
      },
    ])
    expect(types.get('id')).toBe('BIGINT')
    expect(types.get('label')).toBe('VARCHAR')
    expect(types.get('amount')).toBe('DECIMAL(10,2)')
    expect(types.get('ratio')).toBe('DOUBLE')
    expect(types.get('tags')).toBe('INTEGER[]')
    expect(types.get('rec')).toBe('STRUCT(a INTEGER)')
    expect(types.get('blob')).toBe('BLOB')
    expect(types.get('day')).toBe('DATE')
    expect(types.get('flag')).toBe('BOOLEAN')
    expect(types.get('status')).toBe("ENUM('a', 'b')")
  })

  it('reports the post-repair cast outside the wrap as the declared type', () => {
    const ops: EditOp[] = [
      REPAIR(new Map([['x', 'y']])),
      { kind: 'column-cast', column: 'label', targetType: 'BIGINT' },
    ]
    const types = describedTypes(ops)
    expect(types.get('label')).toBe('BIGINT')
  })

  it('keeps the composed schema runnable end-to-end through window and cast check', () => {
    // The composed cast check for a repair column answers the same question
    // the committed window would: a mapping target hoisted as a constant
    // ('1' converts), '5.5' converts by rounding (probe17 T2 — pin whatever
    // the engine does), and a passthrough that cannot convert fires it.
    const checkSql = composeOverlayCastCheckSql(
      compositionFor([REPAIR(new Map([['alpha', '1']]))]),
      'label',
      'BIGINT',
    )
    const clean = runCli(
      [
        'CREATE TABLE assay_t1 (id BIGINT, label VARCHAR);',
        `INSERT INTO assay_t1 VALUES (0, 'alpha'), (1, '5.5');`,
      ],
      checkSql + ';',
    )
    expect(clean).toEqual([]) // mapped constant converts; '5.5' rounds to 6
    const failing = runCli(
      [
        'CREATE TABLE assay_t1 (id BIGINT, label VARCHAR);',
        `INSERT INTO assay_t1 VALUES (0, 'not-a-number');`,
      ],
      checkSql + ';',
    )
    expect(failing).toEqual(['1']) // the existence probe fires on the passthrough
  })
})
