// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * EW-03I-b — projecting one preview result into display state.
 *
 * The engine returns the sniff payload, the effective option set and an
 * optional bounded Arrow sample (`EngineCsvPreviewResult`). Everything here is
 * a pure projection of that response into text, so the surface can be pinned
 * by unit tests and so no dataset value ever leaves the render path:
 *
 * - **Rows** come through the existing window projector
 *   (`projectBatchToRows`, `apps/web/src/grid/provider.ts`) — reused, never a
 *   second Arrow reader — and each cell through the grid's own
 *   `formatCell`, so a decimal/temporal cell reads exactly as the grid would
 *   render it. A NULL cell renders as the literal `NULL` instead of a blank,
 *   because blank and empty-string are different facts (D6).
 * - **Column names/types** come from the engine's own disclosure: the sniff
 *   payload's `columns` (after the reader's renames — D3), replaced by the
 *   declared `columns` map when the user declared one, because a declaration
 *   IS the scan's column naming. The batch itself carries no DuckDB type text
 *   (`ArrowTableLike` exposes no schema), so nothing here guesses a type.
 * - A **column-count disagreement** between the returned batch and the
 *   disclosure is a reader deviation; the sample is then withheld with a fixed
 *   sentence rather than drawn with invented headers.
 *
 * Nothing in this module logs, and nothing composes SQL.
 */
import type { EngineCsvEffectiveOptions, EngineCsvSniff } from '@assay/engine-duckdb'
import type { EngineCsvPreviewResult } from '@assay/engine-duckdb'
import { formatCell } from '../grid/format'
import { projectBatchToRows } from '../grid/provider'
import type { ArrowTableLike } from '../grid/provider'
import { CSV_REVIEW_NULL_CELL } from './copy'

/** One column of the sample table, as the engine disclosed it. */
export interface CsvSampleColumn {
  readonly name: string
  readonly type: string | null
}

/** The sample table, ready to render (strings only — no Arrow object escapes). */
export interface CsvSampleTable {
  readonly columns: readonly CsvSampleColumn[]
  readonly rows: readonly (readonly string[])[]
  /** The exact LIMIT the worker applied (stated in the UI, never implied). */
  readonly rowCap: number
  readonly hasMore: boolean
}

/** A preview result projected for display, plus the sample when it agreed. */
export interface CsvPreviewView {
  readonly previewId: string
  readonly sniff: EngineCsvSniff
  readonly effectiveOptions: EngineCsvEffectiveOptions
  /** The disclosure's column list (scan names when declared, else sniffed). */
  readonly columns: readonly CsvSampleColumn[]
  /** Null when the response carried no sample, or when it disagreed. */
  readonly sample: CsvSampleTable | null
  /** True when a sample arrived but its columns disagreed with the disclosure. */
  readonly sampleMismatch: boolean
}

/**
 * The scan's column list: a declared `columns` map names the scan's columns
 * (and fixes their types), so it wins over the sniff payload — which is the
 * sniffer's own evidence and deliberately excludes declarations (see
 * `csvSniffSql` in the engine package).
 */
export function disclosureColumns(
  sniff: EngineCsvSniff,
  effectiveOptions: EngineCsvEffectiveOptions,
): CsvSampleColumn[] {
  const declared = effectiveOptions.columns
  if (declared !== undefined && Object.keys(declared).length > 0) {
    return Object.entries(declared).map(([name, type]) => ({ name, type }))
  }
  return sniff.columns.map((column) => ({ name: column.name, type: column.type }))
}

/** A cell as text: NULL stays visibly NULL, everything else formats as the grid does. */
export function formatSampleCell(value: unknown, type?: string): string {
  if (value === null || value === undefined) return CSV_REVIEW_NULL_CELL
  return formatCell(value, type)
}

/**
 * Project one Arrow batch to display rows. The projector decides the cell
 * count; a row whose cell count differs from the disclosed column count is
 * the mismatch case the caller renders as withheld.
 */
export function projectSampleBatch(
  batch: ArrowTableLike,
  columns: readonly CsvSampleColumn[],
): { readonly agreed: boolean; readonly rows: readonly (readonly string[])[] } {
  const rows = projectBatchToRows(batch).map((row) =>
    row.map((cell, index) => formatSampleCell(cell, columns[index]?.type ?? undefined)),
  )
  const widths = new Set(rows.map((row) => row.length))
  const agreed =
    rows.every((row) => row.length === columns.length) &&
    widths.size <= 1 &&
    batch.numCols === columns.length
  return { agreed, rows }
}

/** Project one engine response for render. Pure; no DOM, no logging. */
export function toPreviewView(result: EngineCsvPreviewResult): CsvPreviewView {
  const columns = disclosureColumns(result.sniff, result.effectiveOptions)
  if (result.sample === null) {
    return {
      previewId: result.previewId,
      sniff: result.sniff,
      effectiveOptions: result.effectiveOptions,
      columns,
      sample: null,
      sampleMismatch: false,
    }
  }
  const projected = projectSampleBatch(result.sample.batch, columns)
  if (!projected.agreed) {
    return {
      previewId: result.previewId,
      sniff: result.sniff,
      effectiveOptions: result.effectiveOptions,
      columns,
      sample: null,
      sampleMismatch: true,
    }
  }
  return {
    previewId: result.previewId,
    sniff: result.sniff,
    effectiveOptions: result.effectiveOptions,
    columns,
    sample: {
      columns,
      rows: projected.rows,
      rowCap: result.sample.rowCap,
      hasMore: result.sample.hasMore,
    },
    sampleMismatch: false,
  }
}

/** Render a boolean disclosure value ("Yes"/"No", never a blank). */
export function displayBoolean(value: boolean): string {
  return value ? 'Yes' : 'No'
}
