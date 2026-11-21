// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Focused unit tests for the extracted COPY/export emission group (D04b).
 *
 * The composed SQL itself is already pinned end-to-end — byte-level snapshots
 * in `overlay-query.test.ts`, repair-budget/CLI agreement in
 * `overlay-repair-query.test.ts`, native/CLI round-trips in
 * `export-boundary.test.ts` — and those expectations did not change when the
 * group moved modules. What those suites cannot show is the SEAM, so this file
 * pins it:
 *
 * - the COPY wraps **exactly** the export SELECT the other ops share (one
 *   composition, never a second derivation of the effective relation);
 * - the pinned option tokens have ONE canonical owner (`PARQUET_COPY_OPTIONS`
 *   is both the `parquet` entry and the pipeline export node's fragment);
 * - the destination is a quoted string literal (escaping included) and the
 *   arrow path stays the streamed null case;
 * - the CSV header guard travels with the export SELECT and only there.
 */
import { describe, expect, it } from 'vitest'
import { foldOverlay } from '@assay/domain'
import type { EditOp, OverlayBase } from '@assay/domain'
import { quotedIdentifier } from './format-view'
import {
  PARQUET_COPY_OPTIONS,
  composeOverlayExportSelectSql,
  composeOverlayExportSql,
  exportFileExtension,
} from './export-query'
import type { EngineExportFormat } from './protocol'

const BASE: OverlayBase = {
  baseAnchor: 'b1',
  overlayAnchor: 'o1',
  columns: [
    { name: 'id', type: 'BIGINT' },
    { name: 'label', type: 'VARCHAR' },
  ],
  baseRowCount: 3,
}

const NO_OPS: EditOp[] = []

function compositionFor(base: OverlayBase = BASE, ops: EditOp[] = NO_OPS) {
  return { viewName: 'assay_t1', base, state: foldOverlay(base, ops).state }
}

/**
 * The documented header-guard convention, written out locally (the composer's
 * own reading of it is what the assertions below pin): a name starting with
 * `=`/`+`/`-`/`@`, or carrying TAB/LF/CR anywhere, gains a leading apostrophe;
 * the guarded name then becomes a SQL string literal (quotes doubled).
 */
function guardedAliasLiteral(name: string): string {
  const triggers = ['=', '+', '-', '@']
  const guarded =
    triggers.some((trigger) => name.startsWith(trigger)) ||
    name.includes('\t') ||
    name.includes('\n') ||
    name.includes('\r')
      ? `'${name}`
      : name
  return "'" + guarded.replaceAll("'", "''") + "'"
}

/** The documented trigger forms for the CSV header guard (one name each). */
const HOSTILE_NAMES = ['=SUM(A2:A3)', '+x', '-x', '@x', 'tab\there', 'lf\nhere', 'cr\rhere']

describe('PARQUET_COPY_OPTIONS — one canonical owner (D04b)', () => {
  it('pins the ADR 0038 parquet options and is the token the parquet COPY emits', () => {
    expect(PARQUET_COPY_OPTIONS).toBe('FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 122880')
    const sql = composeOverlayExportSql(compositionFor(), 'parquet', 'assay-export-1')
    expect(sql).toContain(`) TO 'assay-export-1' (${PARQUET_COPY_OPTIONS})`)
  })
})

describe('composeOverlayExportSql — COPY wraps the shared export SELECT', () => {
  it('composes `COPY (<export SELECT>) TO <literal> (<options>)` for every copyable format', () => {
    const composition = compositionFor()
    const options: Record<Exclude<EngineExportFormat, 'arrow'>, string> = {
      parquet: PARQUET_COPY_OPTIONS,
      csv: "FORMAT CSV, HEADER true, DELIMITER ',', QUOTE '\"', ESCAPE '\"'",
      jsonl: 'FORMAT JSON, ARRAY false',
      json: 'FORMAT JSON, ARRAY true',
    }
    for (const [format, optionToken] of Object.entries(options)) {
      const exportFormat = format as Exclude<EngineExportFormat, 'arrow'>
      const destination = `assay-export-${format}`
      expect(composeOverlayExportSql(composition, exportFormat, destination)).toBe(
        `COPY (${composeOverlayExportSelectSql(composition, exportFormat)}) ` +
          `TO '${destination}' (${optionToken})`,
      )
    }
  })

  it('keeps arrow out of the COPY path (streamed Arrow IPC instead)', () => {
    expect(composeOverlayExportSql(compositionFor(), 'arrow', 'assay-export-arrow')).toBeNull()
  })

  it('escapes a hostile destination as a SQL string literal', () => {
    const sql = composeOverlayExportSql(compositionFor(), 'parquet', "x'); DROP TABLE t; --")
    expect(sql).toContain("TO 'x''); DROP TABLE t; --' (")
    expect(sql).not.toContain("TO 'x');")
  })

  it('refuses a format outside the pinned table (defensive, unreachable from the wire)', () => {
    // The protocol's `EngineExportFormat` vocabulary is closed; this asserts
    // the composer's own guard rather than the wire's.
    const unknown = 'xlsx' as EngineExportFormat
    expect(() => composeOverlayExportSql(compositionFor(), unknown, 'e')).toThrow(
      /unsupported export format: xlsx/,
    )
  })
})

describe('exportFileExtension', () => {
  it('is the identity on the closed format vocabulary', () => {
    const formats: EngineExportFormat[] = ['parquet', 'csv', 'jsonl', 'json', 'arrow']
    for (const format of formats) expect(exportFileExtension(format)).toBe(format)
  })
})

describe('composeOverlayExportSelectSql — CSV header guard stays with the emission', () => {
  it('aliases every CSV column to its apostrophe-guarded name', () => {
    const base: OverlayBase = {
      ...BASE,
      columns: [
        { name: 'id', type: 'BIGINT' },
        ...HOSTILE_NAMES.map((name) => ({ name, type: 'VARCHAR' })),
      ],
    }
    const sql = composeOverlayExportSelectSql(compositionFor(base), 'csv')
    for (const name of HOSTILE_NAMES) {
      expect(sql).toContain(`${quotedIdentifier(name)} AS ${guardedAliasLiteral(name)}`)
    }
    // A benign name is aliased verbatim (no apostrophe prefix).
    expect(sql).toContain(`"id" AS 'id'`)
  })

  it('never guards a non-csv projection (there a name is a data key)', () => {
    const base: OverlayBase = {
      ...BASE,
      columns: [
        { name: 'id', type: 'BIGINT' },
        { name: '=cmd', type: 'VARCHAR' },
      ],
    }
    for (const format of ['parquet', 'jsonl', 'json', 'arrow'] as const) {
      const sql = composeOverlayExportSelectSql(compositionFor(base), format)
      expect(sql).not.toContain("AS '")
      expect(sql).not.toContain("'=cmd'")
    }
  })
})
